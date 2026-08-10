# Store screenshots

Drop your raw phone captures in `raw/`, run one command, upload what comes out.

```bash
powershell -ExecutionPolicy Bypass -File scripts/make-screenshots.ps1
```

`raw/` is gitignored — the captures are yours and regenerable. `appstore/` and
`play/` are the deliverables and are committed.

---

## 1. Shoot these eight, in this order

Name them `01.png` … `08.png`. **The number picks the caption**, so the order is
the only thing that matters — the script does not look at the image.

| # | Screen | Caption it will get |
|---|---|---|
| 1 | The feed, with real music posts | Music first. Not an afterthought. |
| 2 | **Laybell TV in landscape**, Films shelf visible | Turn it sideways for Films. |
| 3 | Going live, with tips visible | Go live. Get tipped in real time. |
| 4 | A profile showing the shop button | Your profile is your storefront. |
| 5 | A shop listing screen | Sell beats. Buyers get the files instantly. |
| 6 | Studio / listening session | Run a session. Bring an audience. |
| 7 | Communities | Communities that stay about the music. |
| 8 | Wallet and earnings | Your earnings, in one wallet. |

Shots 1 and 2 are the only ones most people ever see — they appear in search
results without anyone tapping through. Spend your time there.

**Shoot #2 with the phone actually rotated.** The script detects a landscape
capture and builds it as a landscape store frame; a landscape feature squeezed
into a portrait frame reads as an orange rectangle at thumbnail size.

**Shoot on `laybellreview`.** It carries both subscription tiers, so the feed is
ad-free and the Films shelf is real, and no upsell wall can appear in frame.

Any capture size works — the script fits, never crops, so nothing gets cut off.

## 2. Getting them off the iPhone

iCloud Photos on Windows, Google Drive, or emailing them to yourself all work.
Keep them as PNG if you can; the script accepts JPG too.

## 3. What you get

| Folder | Size | For |
|---|---|---|
| `appstore/` | 1320×2868 (2868×1320 landscape) | Apple 6.9" — covers every iPhone |
| `play/` | 1080×2160 (1920×1080 landscape) | Google Play phone screenshots |

Upload each folder in filename order.

### Why the two stores get different files

Apple's 6.9" frame is 1320×2868 — a ratio of 2.17:1. Google Play refuses any
image whose *"maximum dimension is more than twice as long as the minimum
dimension"*, so **the Apple file is invalid on Play by 8%**. 1080×2160 is exactly
2.00:1 and clears it without cropping anything.

Both stores also forbid transparency (Apple: *"No alpha channels or
transparencies permitted"*; Play: *"24-bit PNG (no alpha)"*), and the drawing
API used here can only write 32-bit PNGs — so every frame is flattened on the
way out. That exact trap had both Play graphics silently mis-formatted until
2026-08-10.

## 4. Changing a caption

Edit `$CAPTIONS` at the top of `scripts/make-screenshots.ps1` and re-run. Keep
them short enough to read at thumbnail size, and keep the file ASCII — a
non-ASCII character in a PowerShell string came back mojibake and broke the
parse once already in this repo.
