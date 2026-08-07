// A file uploader that can actually finish a long transfer.
//
// WHY THIS EXISTS — the defect it routes around, exactly:
// expo-file-system's uploader builds its iOS session from
// `URLSessionConfiguration.default` (ios/Legacy/NetworkingHelpers.swift) and
// never sets a per-request timeout. That default carries
// `timeoutIntervalForRequest = 60`, an IDLE timeout that also governs the wait
// for the server's response after the last byte is sent. Nothing in the JS API
// can change it. So any upload that stalls for a minute — or whose server takes
// a minute to finalise a large file — dies with
// `NSURLErrorDomain Code=-1001 "The request timed out"`. Short clips never
// notice; every long video hit it.
//
// React Native's own XMLHttpRequest goes through RCTNetworking, which DOES
// apply the JS-set timeout to the request (`request.timeoutInterval =
// [RCTConvert NSTimeInterval:query[@"timeout"]]`). So the same upload, sent
// this way with a generous timeout, is not subject to the 60-second wall.
//
// THE TRADE-OFF, stated plainly: RCTNetworking assembles multipart bodies into
// an in-memory `NSMutableData`, so the file is buffered rather than streamed.
// That is fine for the compressed masters this path carries (~180 MB target)
// and would NOT be fine for a raw multi-GB source — which is precisely why
// compression runs first and why callers gate on size before choosing this.
// The permanent fix is the patch in patches/ that gives expo-file-system a
// real timeout; that one streams AND has no wall, and takes effect on the next
// native build.

export type XhrUploadResult = { status: number; body: string };

export async function uploadFileViaXhr(
  url: string,
  fileUri: string,
  opts: {
    method?: 'POST' | 'PUT';
    headers?: Record<string, string>;
    /** Multipart field name. Omit for a raw binary body. */
    fieldName?: string;
    fileName?: string;
    mimeType?: string;
    onProgress?: (fraction: number) => void;
    /** Milliseconds. Generous by design — this is the whole point. */
    timeoutMs?: number;
  } = {},
): Promise<XhrUploadResult> {
  const {
    method = 'POST',
    headers = {},
    fieldName,
    fileName = 'video.mp4',
    mimeType = 'video/mp4',
    onProgress,
    timeoutMs = 2 * 60 * 60 * 1000, // 2 hours: a ceiling, not an expectation
  } = opts;

  return new Promise<XhrUploadResult>((resolve, reject) => {
    let settled = false;
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    // The line this module exists for.
    xhr.timeout = timeoutMs;
    for (const [k, v] of Object.entries(headers)) {
      try { xhr.setRequestHeader(k, v); } catch { /* forbidden header — ignore */ }
    }
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (e: any) => {
        if (e && e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
      };
    }
    const fail = (msg: string, code?: string) => {
      if (settled) return;
      settled = true;
      const err: any = new Error(msg);
      if (code) err.code = code;
      reject(err);
    };
    xhr.onload = () => {
      if (settled) return;
      settled = true;
      resolve({ status: xhr.status, body: typeof xhr.responseText === 'string' ? xhr.responseText : '' });
    };
    xhr.onerror = () => fail('The connection dropped during the upload', 'network');
    xhr.ontimeout = () => fail('The upload timed out', 'timeout');
    xhr.onabort = () => fail('The upload was cancelled', 'aborted');

    // React Native turns a {uri,name,type} part into a real file part natively —
    // JS never reads the bytes.
    const filePart: any = { uri: fileUri, name: fileName, type: mimeType };
    if (fieldName) {
      const form = new FormData();
      form.append(fieldName, filePart);
      xhr.send(form as any);
    } else {
      xhr.send(filePart);
    }
  });
}
