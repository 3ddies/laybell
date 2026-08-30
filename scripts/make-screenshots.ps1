# Turns raw phone screenshots into store-ready gallery frames for BOTH stores.
#   powershell -ExecutionPolicy Bypass -File scripts/make-screenshots.ps1
#
# IN   store/screenshots/raw/       01*.png, 02*.png ... (any size; sorted by name)
# OUT  store/screenshots/appstore/  1320 x 2868   (Apple 6.9", covers every iPhone)
#      store/screenshots/play/      1080 x 1920   (Play phone, exactly 9:16)
#      store/screenshots/tablet/    1440 x 2560   (Play 7in AND 10in tablet)
#
# Play marks BOTH tablet slots required. 7-inch wants each side in 320-3840 and
# 10-inch wants 1080-7680, so one 1440x2560 set satisfies both with room to
# spare - the phone set's 1080 short side sits exactly ON the 10-inch minimum,
# and a bound you are sitting exactly on is a bound worth clearing properly.
#
# A LANDSCAPE source is written at landscape size instead - 2868 x 1320 for
# Apple, 1920 x 1080 for Play - keeping the numbering, so each folder can just
# be uploaded in filename order.
#
# WHY TWO SIZES. Apple's 6.9" frame is 1320x2868, a ratio of 2.17:1, and Play
# will not take it. Play's own upload panel asks for "16:9 or 9:16 aspect ratio"
# - so 1080x1920 exactly, NOT the 1080x2160 this script produced at first. That
# was 2.00:1, which satisfies Play's documented "max dimension no more than
# twice the min" rule but is not 9:16, and the console states the stricter one.
# 1080x1920 passes both readings, so it is the safe target.
#
# The phone capture sits smaller inside a 9:16 frame than a 2:1 one - a modern
# handset is about 9:19.5, so fitting it whole leaves gradient down each side.
# That is deliberate: cropping to fill would cut the very UI the screenshot
# exists to show.
#
# NO ALPHA, EITHER STORE. Apple: "No alpha channels or transparencies permitted."
# Play: "JPEG or 24-bit PNG (no alpha)". System.Drawing always writes 32bpp ARGB,
# so normalize-store-assets.mjs is run at the end to flatten every output. This
# is the same trap that would have had both Play graphics rejected at upload.
#
# The caption sits ABOVE the screenshot on a brand panel rather than on top of
# the app. Overlaid text lands on whatever happens to be under it and moves
# frame to frame; a panel is identical in every shot, which is the thing
# STORE_LISTING.md 4 asks for and the thing that reads as professional.
#
# ASCII only on purpose: a non-ASCII character in a PowerShell string came back
# mojibake and broke the parse once already in this repo.

param(
  # Background scheme. The set is judged as THUMBNAILS in a search-results grid
  # long before anyone opens it, so this is not decoration - it decides whether
  # the tile is noticed at all.
  #   brand     the original red->orange. Loudest in a grid, and the loudest
  #             thing about it is that it is loud.
  #   ember     deep burnt orange into charcoal. Brand-adjacent, calmer, and it
  #             stops competing with the orange still inside the UI.
  #   graphite  warm near-black. Matches the app, premium, but a dark shot on a
  #             dark ground risks reading as one dark blob at tile size.
  #   paper     the light theme's off-white with dark caption text. Highest
  #             contrast against a dark-UI capture; pops hardest in a grid.
  [ValidateSet('brand', 'ember', 'graphite', 'paper')]
  [string]$Bg = 'brand',
  # Render only the first N shots, into store/screenshots/preview/<Bg>/ - for
  # comparing schemes without rebuilding all three size sets.
  [int]$PreviewCount = 0
)

Add-Type -AssemblyName System.Drawing

# Left colour, right colour, caption ink, device edge alpha. The edge matters
# most on the dark schemes: a near-black capture on a near-black ground needs a
# rim to read as a device rather than a hole.
$SCHEMES = @{
  brand    = @{ L = @(233, 30, 14);  R = @(255, 140, 0);   Ink = @(255, 255, 255); Edge = 70  }
  ember    = @{ L = @(122, 42, 16);  R = @(28, 22, 20);    Ink = @(255, 255, 255); Edge = 110 }
  graphite = @{ L = @(16, 15, 14);   R = @(38, 35, 32);    Ink = @(255, 255, 255); Edge = 140 }
  paper    = @{ L = @(242, 241, 237); R = @(252, 251, 247); Ink = @(22, 22, 26);   Edge = 40  }
}
$SC = $SCHEMES[$Bg]

$repo = Split-Path -Parent $PSScriptRoot
$rawDir = Join-Path $repo 'store\screenshots\raw'
$outApple = Join-Path $repo 'store\screenshots\appstore'
$outPlay = Join-Path $repo 'store\screenshots\play'
$outTablet = Join-Path $repo 'store\screenshots\tablet'
$outLand = Join-Path $repo 'store\screenshots\landscape'

# Captions, in shot order, from docs/STORE_LISTING.md section 4.
$CAPTIONS = @(
  'Music first. Not an afterthought.',
  'Turn it sideways for Films.',
  'Go live. Get tipped in real time.',
  'Your profile is your storefront.',
  'Sell beats. Buyers get the files instantly.',
  'Run a session. Bring an audience.',
  'Communities that stay about the music.',
  'Your earnings, in one wallet.'
)

if (-not (Test-Path $rawDir)) { New-Item -ItemType Directory -Force $rawDir | Out-Null }
foreach ($d in @($outApple, $outPlay, $outTablet, $outLand)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force $d | Out-Null }
}

$raws = @(Get-ChildItem -Path $rawDir -File | Where-Object { $_.Extension -match '^\.(png|jpg|jpeg)$' } | Sort-Object Name)
if ($raws.Count -eq 0) {
  Write-Output ''
  Write-Output "No screenshots found in store\screenshots\raw\."
  Write-Output 'Drop the phone captures there named 01.png, 02.png ... in the'
  Write-Output 'order listed in docs/STORE_LISTING.md section 4, then re-run.'
  exit 0
}

# Draws the gradient one column at a time. A GDI+ LinearGradientBrush tiles
# past the rectangle it was built for and leaves a visible seam; per-column
# strips cannot.
function Paint-Gradient($g, $w, $h) {
  for ($x = 0; $x -lt $w; $x++) {
    $t = $x / [double]($w - 1)
    $r = [int]($SC.L[0] + ($SC.R[0] - $SC.L[0]) * $t)
    $gr = [int]($SC.L[1] + ($SC.R[1] - $SC.L[1]) * $t)
    $b = [int]($SC.L[2] + ($SC.R[2] - $SC.L[2]) * $t)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, $r, $gr, $b))
    $g.DrawLine($pen, $x, 0, $x, $h)
    $pen.Dispose()
  }
}

# Word-wraps to at most 2 lines at the widest font that still fits.
function Get-CaptionLines($g, $text, $font, $maxW) {
  $words = $text.Split(' ')
  $lines = New-Object System.Collections.ArrayList
  $cur = ''
  foreach ($w in $words) {
    $try = if ($cur -eq '') { $w } else { "$cur $w" }
    if ($g.MeasureString($try, $font).Width -le $maxW) { $cur = $try }
    else { [void]$lines.Add($cur); $cur = $w }
  }
  if ($cur -ne '') { [void]$lines.Add($cur) }
  return $lines
}

function Build-Frame($srcPath, $caption, $canvasW, $canvasH, $destPath) {
  $src = [System.Drawing.Image]::FromFile($srcPath)
  $bmp = New-Object System.Drawing.Bitmap($canvasW, $canvasH)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.TextRenderingHint = 'ClearTypeGridFit'

  Paint-Gradient $g $canvasW $canvasH

  # Everything below scales off the canvas's SHORT side, so the Apple and Play
  # frames are the same design rather than two that merely resemble each other.
  # Short side, not width: on a 2868-wide landscape frame, scaling by width
  # blows the caption up to 126px and its margins eat the height the picture
  # needed, leaving the screenshot stranded at a third of the frame. Portrait is
  # unaffected - its width IS its short side.
  $s = [Math]::Min($canvasW, $canvasH) / 1320.0
  $capTop = [int](140 * $s)
  $sideMargin = [int](110 * $s)
  $fontSize = [single](58 * $s)
  $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $maxTextW = $canvasW - (2 * $sideMargin)

  $lines = Get-CaptionLines $g $caption $font $maxTextW
  $lineH = [int]($fontSize * 1.25)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, $SC.Ink[0], $SC.Ink[1], $SC.Ink[2]))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'

  $y = $capTop
  foreach ($ln in $lines) {
    $rect = New-Object System.Drawing.RectangleF(0, $y, $canvasW, $lineH)
    $g.DrawString($ln, $font, $brush, $rect, $fmt)
    $y += $lineH
  }

  # Content box: below the caption, with a floor so the shot never touches the edge.
  $contentTop = $y + [int](70 * $s)
  $contentBottom = $canvasH - [int](110 * $s)
  $availW = $canvasW - (2 * $sideMargin)
  $availH = $contentBottom - $contentTop

  # Fit ENTIRELY inside the box - never crop. A cropped store screenshot loses
  # the very UI it is meant to be showing.
  $scale = [Math]::Min($availW / $src.Width, $availH / $src.Height)
  $dw = [int]($src.Width * $scale)
  $dh = [int]($src.Height * $scale)
  $dx = [int](($canvasW - $dw) / 2)
  $dy = $contentTop + [int](($availH - $dh) / 2)

  # Rounded corners so the capture reads as a device screen, not a pasted rectangle.
  $r = [int](46 * $s)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($dx, $dy, 2 * $r, 2 * $r, 180, 90)
  $path.AddArc($dx + $dw - 2 * $r, $dy, 2 * $r, 2 * $r, 270, 90)
  $path.AddArc($dx + $dw - 2 * $r, $dy + $dh - 2 * $r, 2 * $r, 2 * $r, 0, 90)
  $path.AddArc($dx, $dy + $dh - 2 * $r, 2 * $r, 2 * $r, 90, 90)
  $path.CloseFigure()

  $state = $g.Save()
  $g.SetClip($path)
  $g.DrawImage($src, $dx, $dy, $dw, $dh)
  $g.Restore($state)

  $edgeInk = if ($Bg -eq 'paper') { @(0, 0, 0) } else { @(255, 255, 255) }
  $edge = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb($SC.Edge, $edgeInk[0], $edgeInk[1], $edgeInk[2]), [single](3 * $s))
  $g.DrawPath($edge, $path)

  $bmp.Save($destPath, [System.Drawing.Imaging.ImageFormat]::Png)

  $edge.Dispose(); $path.Dispose(); $fmt.Dispose(); $brush.Dispose()
  $font.Dispose(); $g.Dispose(); $bmp.Dispose(); $src.Dispose()
}

# PREVIEW MODE: one Apple-sized frame per shot into its own folder, so two
# schemes can be compared side by side without rebuilding three size sets each
# time. Judging a background from a description does not work; judging it from
# the actual frame takes seconds.
$preview = $PreviewCount -gt 0
if ($preview) {
  $outPreview = Join-Path $repo ('store\screenshots\preview\' + $Bg)
  if (-not (Test-Path $outPreview)) { New-Item -ItemType Directory -Force $outPreview | Out-Null }
}

$i = 0
foreach ($f in $raws) {
  if ($preview -and $i -ge $PreviewCount) { break }
  $caption = if ($i -lt $CAPTIONS.Count) { $CAPTIONS[$i] } else { '' }
  $n = '{0:d2}' -f ($i + 1)

  $probe = [System.Drawing.Image]::FromFile($f.FullName)
  $isLandscape = $probe.Width -gt $probe.Height
  $probe.Dispose()

  # A landscape capture gets a LANDSCAPE frame. Dropping one into the portrait
  # canvas leaves a thin band adrift in a field of gradient - at thumbnail size
  # in search results that frame reads as an orange rectangle, which is exactly
  # the "a portrait screenshot of a landscape feature undersells it" that
  # STORE_LISTING.md 4 warns about. Apple lists portrait AND landscape as valid
  # dimensions for the same 6.9" slot, so a mixed set uploads fine.
  if ($preview) {
    if ($isLandscape) { Build-Frame $f.FullName $caption 2868 1320 (Join-Path $outPreview "$n.png") }
    else { Build-Frame $f.FullName $caption 1320 2868 (Join-Path $outPreview "$n.png") }
    Write-Output ("$n  " + $f.Name + '  -> ' + $Bg)
    $i++
    continue
  }

  if ($isLandscape) {
    Build-Frame $f.FullName $caption 2868 1320 (Join-Path $outApple "$n.png")
    Build-Frame $f.FullName $caption 1920 1080 (Join-Path $outPlay "$n.png")
    Build-Frame $f.FullName $caption 2560 1440 (Join-Path $outTablet "$n.png")
  } else {
    Build-Frame $f.FullName $caption 1320 2868 (Join-Path $outApple "$n.png")
    Build-Frame $f.FullName $caption 1080 1920 (Join-Path $outPlay "$n.png")
    Build-Frame $f.FullName $caption 1440 2560 (Join-Path $outTablet "$n.png")
  }

  $tag = if ($isLandscape) { '   [landscape frame]' } else { '' }
  Write-Output "$n  $($f.Name)  -> $caption$tag"
  $i++
}

Write-Output ''
Write-Output "Built $($raws.Count) frame(s) for each store."
node (Join-Path $repo 'scripts\normalize-store-assets.mjs')
