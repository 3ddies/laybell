# Regenerate the Google Play store graphics into store/.
#   powershell -ExecutionPolicy Bypass -File scripts/make-store-assets.ps1
#
# Produces the two assets Play REQUIRES and will not publish without:
#   store/play-icon-512.png         512x512, no alpha (Play rejects transparency)
#   store/play-feature-graphic.png  1024x500
#
# DESIGN RULE, same as the invite card: the mark on the gradient, no type.
# Play prints the app name directly under the feature graphic, so a wordmark
# inside it is redundant AND competes with the real one.
#
# ASCII only on purpose: a non-ASCII character in a PowerShell string came back
# mojibake and broke the parse once already in this repo.

Add-Type -AssemblyName System.Drawing

$repo = 'C:\Users\3ddie\laybell'
$outDir = Join-Path $repo 'store'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

# Shared brand ramp, drawn as per-column strips: GDI+ tiles a LinearGradientBrush
# past its rectangle and leaves a hard vertical seam.
function Draw-Gradient($g, $W, $H) {
  $c1 = @(245, 26, 0)    # deep red, left
  $c2 = @(255, 138, 0)   # warm orange, right
  for ($x = 0; $x -lt $W; $x++) {
    $t = $x / [double]($W - 1)
    $t = $t * $t * (3 - 2 * $t)   # smoothstep, so the middle is not a flat band
    $r = [int]($c1[0] + ($c2[0] - $c1[0]) * $t)
    $gg = [int]($c1[1] + ($c2[1] - $c1[1]) * $t)
    $b = [int]($c1[2] + ($c2[2] - $c1[2]) * $t)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($r, $gg, $b))
    $g.DrawLine($pen, $x, 0, $x, $H)
    $pen.Dispose()
  }
}

# The bell occupies ~42% of android-icon-foreground.png's canvas (it is padded
# for Android's adaptive safe zone), so draw oversized to land the BELL at the
# height wanted and let the transparent padding overhang.
$markPath = Join-Path $repo 'assets\android-icon-foreground.png'

function Build($W, $H, $bellHeight, $outFile) {
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  Draw-Gradient $g $W $H
  $mark = [System.Drawing.Image]::FromFile($markPath)
  $draw = [int]($bellHeight / 0.42)
  $g.DrawImage($mark, [int](($W - $draw) / 2), [int](($H - $draw) / 2), $draw, $draw)
  $bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $mark.Dispose()
  Write-Output "wrote $outFile ($W x $H)"
}

# Feature graphic: 1024x500. The bell stays well inside the safe middle -- Play
# crops this banner on some surfaces and overlays UI on others.
Build 1024 500 260 (Join-Path $outDir 'play-feature-graphic.png')

# Play icon: 512x512. Rebuilt from icon.png rather than the bare mark, because
# the store icon must be the full app icon (background included) and must be
# fully opaque -- Play rejects any alpha channel.
$src = [System.Drawing.Image]::FromFile((Join-Path $repo 'assets\icon.png'))
$icon = New-Object System.Drawing.Bitmap(512, 512, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$ig = [System.Drawing.Graphics]::FromImage($icon)
$ig.InterpolationMode = 'HighQualityBicubic'
$ig.SmoothingMode = 'AntiAlias'
$ig.DrawImage($src, 0, 0, 512, 512)
$iconOut = Join-Path $outDir 'play-icon-512.png'
$icon.Save($iconOut, [System.Drawing.Imaging.ImageFormat]::Png)
$ig.Dispose(); $icon.Dispose(); $src.Dispose()
Write-Output "wrote $iconOut (512 x 512, 24bpp - no alpha)"
