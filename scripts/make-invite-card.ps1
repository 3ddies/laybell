# Regenerate web/invite-card.png (the invite link preview image).
#   powershell -ExecutionPolicy Bypass -File scripts/make-invite-card.ps1
# After running, bump the ?v= on og:image in web/invite.html or Apple keeps
# serving the cached picture.
#
# DESIGN RULE: the mark on the gradient. NOTHING ELSE.
# A tagline was baked in here once and it looked like an ad, not a brand -- the
# card sits next to Spotify's and Apple Music's in the same thread, and those
# are silent. The words belong in og:title ("Download Laybell"), which the
# platform sets in its own type; the picture stays clean.

Add-Type -AssemblyName System.Drawing

$W = 1200; $H = 630
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.InterpolationMode = 'HighQualityBicubic'

# Gradient drawn as explicit vertical strips rather than a LinearGradientBrush:
# GDI+ tiles that brush past its rectangle and left a hard vertical seam at
# ~58% of the width. One strip per column has no wrap to get wrong.
$c1 = @(245, 26, 0)    # deep red, left
$c2 = @(255, 138, 0)   # warm orange, right
for ($x = 0; $x -lt $W; $x++) {
  # Smoothstep, so the middle doesn't read as a flat band the way a pure linear
  # blend between two saturated hues does.
  $t = $x / ($W - 1)
  $t = $t * $t * (3 - 2 * $t)
  $r = [int]($c1[0] + ($c2[0] - $c1[0]) * $t)
  $gg = [int]($c1[1] + ($c2[1] - $c1[1]) * $t)
  $b = [int]($c1[2] + ($c2[2] - $c1[2]) * $t)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($r, $gg, $b))
  $g.DrawLine($pen, $x, 0, $x, $H)
  $pen.Dispose()
}

# The white bell mark -- android-icon-foreground.png is already the artwork on
# transparency (built for the adaptive icon), so it drops straight on.
$mark = [System.Drawing.Image]::FromFile('C:\Users\3ddie\laybell\assets\android-icon-foreground.png')

# That asset pads the mark into Android's safe zone: the bell occupies ~42% of
# its 1024 canvas. Draw oversized so the BELL lands at the height we want, and
# let the transparent padding overhang the edges.
$bellTarget = 340.0
$markDraw = [int]($bellTarget / 0.42)
$g.DrawImage($mark, [int](($W - $markDraw) / 2), [int](($H - $markDraw) / 2), $markDraw, $markDraw)

$out = 'C:\Users\3ddie\laybell\web\invite-card.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $mark.Dispose()
Write-Output "wrote $out ($W x $H) -- mark only, no type"
