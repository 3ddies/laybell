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
  #   auto      DEFAULT. Picks per frame: a light capture gets a black ground, a
  #             dark one gets white. The set is half and half, so any single
  #             scheme flattens one half - see the drop-shadow note below. This
  #             inverts instead, so every frame is maximum contrast.
  #   black     DEFAULT. Near-black under every frame, light or dark.
  [ValidateSet('black', 'auto', 'brand', 'ember', 'graphite', 'paper')]
  [string]$Bg = 'black',
  # Render only the first N shots, into store/screenshots/preview/<Bg>/ - for
  # comparing schemes without rebuilding all three size sets.
  [int]$PreviewCount = 0
)

Add-Type -AssemblyName System.Drawing

# Left colour, right colour, caption ink, device edge alpha. The edge matters
# most on the dark schemes: a near-black capture on a near-black ground needs a
# rim to read as a device rather than a hole.
$SCHEMES = @{
  brand    = @{ L = @(233, 30, 14);  R = @(255, 140, 0);   Ink = @(255, 255, 255); Edge = 70;  EdgeInk = @(255, 255, 255) }
  ember    = @{ L = @(122, 42, 16);  R = @(28, 22, 20);    Ink = @(255, 255, 255); Edge = 110; EdgeInk = @(255, 255, 255) }
  graphite = @{ L = @(16, 15, 14);   R = @(38, 35, 32);    Ink = @(255, 255, 255); Edge = 140; EdgeInk = @(255, 255, 255) }
  paper    = @{ L = @(242, 241, 237); R = @(252, 251, 247); Ink = @(22, 22, 26);   Edge = 65;  EdgeInk = @(0, 0, 0) }

  # The two AUTO grounds, named for the capture they are used UNDER, not for
  # their own colour - the inversion is the whole point and reading these the
  # wrong way round is easy. Near-black and near-white rather than #000/#fff: a
  # dead-flat ground looks like a rendering error, and a hair of gradient reads
  # as deliberate at tile size while still saying black and white.
  onLight  = @{ L = @(8, 8, 10);     R = @(30, 30, 34);    Ink = @(255, 255, 255); Edge = 130; EdgeInk = @(255, 255, 255) }
  onDark   = @{ L = @(255, 255, 255); R = @(243, 242, 239); Ink = @(9, 9, 12);     Edge = 60;  EdgeInk = @(0, 0, 0) }

  # One ground for the whole set. A dark capture on it has almost no luminance
  # to separate against, so the rim carries more here than in any other scheme -
  # see the halo in Build-Frame, which replaces a shadow that would be black on
  # black and therefore nothing at all.
  black    = @{ L = @(8, 8, 10);     R = @(30, 30, 34);    Ink = @(255, 255, 255); Edge = 150; EdgeInk = @(255, 255, 255) }
}
$SC = if ($Bg -eq 'auto') { $null } else { $SCHEMES[$Bg] }

$repo = Split-Path -Parent $PSScriptRoot
$rawDir = Join-Path $repo 'store\screenshots\raw'
$outApple = Join-Path $repo 'store\screenshots\appstore'
$outPlay = Join-Path $repo 'store\screenshots\play'
$outTablet = Join-Path $repo 'store\screenshots\tablet'
$outLand = Join-Path $repo 'store\screenshots\landscape'

# Captions, in shot order, from docs/STORE_SCREENSHOTS_1.0.1.md.
#
# These are positional: caption N lands on raw file N, so REORDERING THE RAWS
# WITHOUT REORDERING THIS SILENTLY MISLABELS THE GALLERY. The 1.0.0 order is
# gone - it captioned the feed "Go live. Get tipped in real time." the moment
# the 1.0.1 shots went in, because Live moved from 3 to 5.
#
# Frame 1 no longer promises "what you want heard first". That described the
# Featured card, and the capture has none, so it read as a caption pointing at
# something not on screen - the same mistake as telling a reviewer to turn the
# phone sideways for Films.
$CAPTIONS = @(
  'Albums and singles, not just posts.',
  'A whole shelf of films.',
  'Real songs. Not fifteen-second clips.',
  'A player built for listening.',
  'Go live. Get tipped in real time.',
  'Sell beats. Buyers get the files instantly.',
  'Your earnings, in one wallet.',
  'A real catalogue, not a feed.'
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
function Paint-Gradient($g, $w, $h, $sc) {
  for ($x = 0; $x -lt $w; $x++) {
    $t = $x / [double]($w - 1)
    $r = [int]($sc.L[0] + ($sc.R[0] - $sc.L[0]) * $t)
    $gr = [int]($sc.L[1] + ($sc.R[1] - $sc.L[1]) * $t)
    $b = [int]($sc.L[2] + ($sc.R[2] - $sc.L[2]) * $t)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, $r, $gr, $b))
    $g.DrawLine($pen, $x, 0, $x, $h)
    $pen.Dispose()
  }
}

# Mean luminance of the capture's BORDER RING, not the whole image. The ring is
# app chrome - nav bar, tab bar, side margins - and the middle is user content.
# A dark-mode feed full of bright photos averages out to 69 over the whole
# frame, which is nearly the threshold; its ring is 26, which is not close to
# anything. Measured across this set the two groups land at 11-102 and 241, so
# the call is never marginal.
function Get-ChromeLuma($img) {
  $w = 40; $h = 80
  $tb = New-Object System.Drawing.Bitmap($w, $h)
  $tg = [System.Drawing.Graphics]::FromImage($tb)
  $tg.InterpolationMode = 'HighQualityBicubic'
  $tg.DrawImage($img, 0, 0, $w, $h)
  $tg.Dispose()
  $bw = [int]($w * 0.14); $bh = [int]($h * 0.10)
  $vals = New-Object System.Collections.ArrayList
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      if ($x -lt $bw -or $x -ge ($w - $bw) -or $y -lt $bh -or $y -ge ($h - $bh)) {
        $p = $tb.GetPixel($x, $y)
        [void]$vals.Add(0.2126 * $p.R + 0.7152 * $p.G + 0.0722 * $p.B)
      }
    }
  }
  $tb.Dispose()
  $sorted = $vals | Sort-Object
  return [int]$sorted[[int]($sorted.Count / 2)]
}

# Per-character advances derived from PREFIX widths, so kerning pairs survive.
# Measuring each glyph alone loses kerning and returns nonsense for a space
# under GenericTypographic; measuring prefixes costs one extra call per
# character and is simply correct.
function Get-Advances($g, $text, $font, $fmt) {
  $adv = New-Object System.Collections.ArrayList
  $prev = 0.0
  for ($i = 1; $i -le $text.Length; $i++) {
    $w = $g.MeasureString($text.Substring(0, $i), $font, [System.Drawing.PointF]::new(0, 0), $fmt).Width
    [void]$adv.Add($w - $prev)
    $prev = $w
  }
  return $adv
}

function Measure-Tracked($g, $text, $font, $fmt, $track) {
  if ($text.Length -eq 0) { return 0.0 }
  $w = $g.MeasureString($text, $font, [System.Drawing.PointF]::new(0, 0), $fmt).Width
  return $w + ($track * ($text.Length - 1))
}

# iOS display type is tracked TIGHTER than the metrics a font ships with. GDI+
# has no tracking, so each glyph is placed by hand.
function Draw-TrackedLine($g, $text, $font, $brush, $centerX, $y, $fmt, $track) {
  $adv = Get-Advances $g $text $font $fmt
  $total = Measure-Tracked $g $text $font $fmt $track
  $x = $centerX - ($total / 2.0)
  for ($i = 0; $i -lt $text.Length; $i++) {
    $g.DrawString($text.Substring($i, 1), $font, $brush, [single]$x, [single]$y, $fmt)
    $x += $adv[$i] + $track
  }
}

# Word-wraps to at most 2 lines at the widest font that still fits.
function Get-CaptionLines($g, $text, $font, $maxW, $fmt, $track) {
  $words = $text.Split(' ')
  $lines = New-Object System.Collections.ArrayList
  $cur = ''
  foreach ($w in $words) {
    $try = if ($cur -eq '') { $w } else { "$cur $w" }
    # Wrap against the TRACKED width. Wrapping on untracked metrics and drawing
    # tracked means the two disagree, and the line that only just fitted spills.
    if ((Measure-Tracked $g $try $font $fmt $track) -le $maxW) { $cur = $try }
    else { [void]$lines.Add($cur); $cur = $w }
  }
  if ($cur -ne '') { [void]$lines.Add($cur) }

  # BALANCE a two-line caption. Greedy wrapping fills line one and leaves
  # whatever is left, which at 74px strands single words: "Albums and singles,
  # not just / posts." A lone word under a full line reads as a mistake at any
  # size and is glaring at gallery scale. Try every split, keep the evenest one
  # that still fits. Only for two lines - three or more are rare here and
  # balancing them is a different problem.
  if ($lines.Count -eq 2) {
    $best = $null
    $bestDiff = [double]::MaxValue
    for ($k = 1; $k -lt $words.Count; $k++) {
      $a = ($words[0..($k - 1)] -join ' ')
      $b = ($words[$k..($words.Count - 1)] -join ' ')
      $wa = Measure-Tracked $g $a $font $fmt $track
      $wb = Measure-Tracked $g $b $font $fmt $track
      if ($wa -le $maxW -and $wb -le $maxW) {
        $d = [Math]::Abs($wa - $wb)
        if ($d -lt $bestDiff) { $bestDiff = $d; $best = @($a, $b) }
      }
    }
    if ($best) {
      $lines = New-Object System.Collections.ArrayList
      [void]$lines.Add($best[0]); [void]$lines.Add($best[1])
    }
  }
  return $lines
}

function Build-Frame($srcPath, $caption, $canvasW, $canvasH, $destPath) {
  $src = [System.Drawing.Image]::FromFile($srcPath)
  $bmp = New-Object System.Drawing.Bitmap($canvasW, $canvasH)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.TextRenderingHint = 'ClearTypeGridFit'

  # AUTO: invert against the capture. Light shot -> black ground, dark -> white.
  $sc = if ($SC) { $SC } else {
    if ((Get-ChromeLuma $src) -ge 128) { $SCHEMES.onLight } else { $SCHEMES.onDark }
  }

  Paint-Gradient $g $canvasW $canvasH $sc

  # Everything below scales off the canvas's SHORT side, so the Apple and Play
  # frames are the same design rather than two that merely resemble each other.
  # Short side, not width: on a 2868-wide landscape frame, scaling by width
  # blows the caption up to 126px and its margins eat the height the picture
  # needed, leaving the screenshot stranded at a third of the frame. Portrait is
  # unaffected - its width IS its short side.
  $s = [Math]::Min($canvasW, $canvasH) / 1320.0
  $capTop = [int](128 * $s)
  $sideMargin = [int](96 * $s)

  # iOS large-title proportions: bigger, heavier, tracked in, lines close
  # together. 58px read as a caption sitting above a picture; this reads as the
  # headline it is, which is what a store gallery is actually made of.
  #
  # Segoe UI Variable Display is Microsoft's DISPLAY optical size - drawn tighter
  # and with finer detail for large type, which is the same job SF Pro Display
  # does on iOS. No SF face ships with Windows. GDI+ silently substitutes a
  # default for an unknown family rather than failing, so the fallback is
  # explicit: an unnoticed substitution would quietly change every caption.
  # Segoe UI Black is the heaviest face Windows ships, and it is asked for at
  # REGULAR weight - the family is already black, so adding Bold on top makes
  # GDI+ synthesise a smeared fake weight rather than pick a heavier cut. Each
  # candidate is checked with IsStyleAvailable, because GDI+ substitutes silently
  # for a family or style it does not have; a caption set that quietly fell back
  # to Microsoft Sans Serif would still render, just wrong.
  $fontSize = [single](86 * $s)
  $fontPicks = @(
    @{ Fam = 'Segoe UI Black';            Style = [System.Drawing.FontStyle]::Regular },
    @{ Fam = 'Segoe UI Variable Display'; Style = [System.Drawing.FontStyle]::Bold },
    @{ Fam = 'Segoe UI';                  Style = [System.Drawing.FontStyle]::Bold }
  )
  $font = $null
  foreach ($p in $fontPicks) {
    try {
      $ff = New-Object System.Drawing.FontFamily($p.Fam)
      if (-not $ff.IsStyleAvailable($p.Style)) { $ff.Dispose(); continue }
      $font = New-Object System.Drawing.Font($ff, $fontSize, $p.Style, [System.Drawing.GraphicsUnit]::Pixel)
      $ff.Dispose()
      break
    } catch { }
  }
  $maxTextW = $canvasW - (2 * $sideMargin)

  # Typographic, not the default: GDI's default format pads each run, and that
  # padding lands inside every hand-placed glyph once tracking is on.
  $fmt = [System.Drawing.StringFormat]::GenericTypographic.Clone()
  $fmt.FormatFlags = $fmt.FormatFlags -bor [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces
  # Heavier and larger type needs MORE negative tracking, not the same: at 86px
  # black weight the default sidebearings read as gaps.
  $track = [single](-0.026 * $fontSize)

  $lines = Get-CaptionLines $g $caption $font $maxTextW $fmt $track
  $lineH = [int]($fontSize * 1.10)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, $sc.Ink[0], $sc.Ink[1], $sc.Ink[2]))

  $y = $capTop
  foreach ($ln in $lines) {
    Draw-TrackedLine $g $ln $font $brush ($canvasW / 2.0) $y $fmt $track
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

  # Soft drop shadow, drawn UNDER the capture. A rim alone cannot rescue a light
  # capture on a light ground or a dark one on a dark ground, and this set is
  # half each - frames 1/6/7/8 are light mode, 2/3/4/5 are dark. Without this,
  # picking a scheme means picking which half of the gallery goes flat: paper
  # loses the light shots, ember loses the dark ones. A shadow lifts the device
  # whatever its own brightness, so the scheme goes back to being taste.
  #
  # GDI+ has no blur, so it is faked: concentric rounded rects, largest first,
  # each barely visible. They accumulate toward the device and fall off outward,
  # which is what a blur looks like. Nudged down by half the spread so the light
  # reads as coming from above.
  # A SHADOW OR A HALO, whichever the pairing needs. A black shadow under a dark
  # capture on a black ground is a shadow nobody can see - the frames that need
  # lifting most would get nothing. So when both are dark the same falloff is
  # drawn in white, and the device reads as sitting slightly proud of the ground
  # instead of dissolving into it. Bright capture on black needs neither: its own
  # luminance is the separation.
  $groundLuma = (0.2126 * ($sc.L[0] + $sc.R[0]) + 0.7152 * ($sc.L[1] + $sc.R[1]) + 0.0722 * ($sc.L[2] + $sc.R[2])) / 2.0
  $capLuma = Get-ChromeLuma $src
  $halo = ($groundLuma -lt 90) -and ($capLuma -lt 128)
  $glowInk = if ($halo) { 255 } else { 0 }
  $glowMax = if ($halo) { 6 } else { 7 }

  $spread = [int](16 * $s)
  for ($i = $spread; $i -ge 1; $i--) {
    $a = [int]($glowMax * [Math]::Pow(1 - ($i / ($spread + 1)), 2))
    if ($a -le 0) { continue }
    $sx = $dx - $i
    $sy = $dy - $i + [int]($i / 2)
    $sw = $dw + 2 * $i
    $sh = $dh + 2 * $i
    $sr = $r + $i
    $sp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $sp.AddArc($sx, $sy, 2 * $sr, 2 * $sr, 180, 90)
    $sp.AddArc($sx + $sw - 2 * $sr, $sy, 2 * $sr, 2 * $sr, 270, 90)
    $sp.AddArc($sx + $sw - 2 * $sr, $sy + $sh - 2 * $sr, 2 * $sr, 2 * $sr, 0, 90)
    $sp.AddArc($sx, $sy + $sh - 2 * $sr, 2 * $sr, 2 * $sr, 90, 90)
    $sp.CloseFigure()
    $sb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($a, $glowInk, $glowInk, $glowInk))
    $g.FillPath($sb, $sp)
    $sb.Dispose(); $sp.Dispose()
  }

  $state = $g.Save()
  $g.SetClip($path)
  $g.DrawImage($src, $dx, $dy, $dw, $dh)
  $g.Restore($state)

  # Rim ink travels with the ground now. It used to be keyed off the scheme NAME
  # ('paper' means black, everything else white), which cannot express a run
  # where the ground changes frame to frame.
  $edge = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb($sc.Edge, $sc.EdgeInk[0], $sc.EdgeInk[1], $sc.EdgeInk[2]), [single](3 * $s))
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
  $luma = Get-ChromeLuma $probe
  $probe.Dispose()

  # Report the ground per frame. An automatic choice that is never shown is one
  # nobody checks, and a misread capture would otherwise be found by eye later.
  $ground = if ($Bg -ne 'auto') { $Bg } elseif ($luma -ge 128) { 'black' } else { 'white' }

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
  Write-Output ("{0}  {1,-8} luma {2,3}  {3,-5}  {4}{5}" -f $n, $f.Name, $luma, $ground, $caption, $tag)
  $i++
}

Write-Output ''
if ($preview) {
  # Preview mode writes ONLY to preview/<scheme>/. It used to fall through to
  # both lines below, so it claimed to have built all three size sets and then
  # ran the Play normaliser over whatever the last real build had left there -
  # reporting the old set as freshly OK, and exiting non-zero when a file it
  # expected was not there. A preview must not touch what gets uploaded.
  Write-Output "Built $i preview frame(s) in store\screenshots\preview\$Bg\ - nothing else was touched."
  return
}

Write-Output "Built $($raws.Count) frame(s) for each store."
node (Join-Path $repo 'scripts\normalize-store-assets.mjs')
