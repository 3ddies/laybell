# Regenerate web/invite-card.png (the invite link preview image).
#   powershell -ExecutionPolicy Bypass -File scripts/make-invite-card.ps1
# After running, bump the ?v= on og:image in web/invite.html or Apple keeps
# serving the cached picture.
#
# Build the invite card's og:image — a 1200x630 banner carrying the tagline.
#
# WHY THE TAGLINE LIVES IN THE IMAGE: Apple renders only og:title and the
# domain on an iMessage card; og:description is ignored (proven on-device
# twice). So "The newest social media" cannot reach an iPhone as text — baked
# into the artwork, it always shows.
#
# Layout is CENTRED and stacked, not side-by-side: clients crop this image to
# different aspect ratios, and a centred column survives a square crop where a
# left-mark/right-text arrangement would lose the words.

Add-Type -AssemblyName System.Drawing

$W = 1200; $H = 630
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'ClearTypeGridFit'
$g.InterpolationMode = 'HighQualityBicubic'

# Gradient drawn as explicit vertical strips rather than a LinearGradientBrush.
# GDI+ tiles that brush beyond its rectangle, which put a hard vertical seam at
# ~58% of the width in the first cut. One strip per column has no wrap to get
# wrong, and at 1200 strips it is still instant.
$c1 = @(245, 26, 0)    # deep red, left
$c2 = @(255, 138, 0)   # warm orange, right
for ($x = 0; $x -lt $W; $x++) {
  # Ease the ramp slightly (smoothstep) so the middle doesn't read as a flat
  # band the way a pure linear blend between two saturated hues does.
  $t = $x / ($W - 1)
  $t = $t * $t * (3 - 2 * $t)
  $r = [int]($c1[0] + ($c2[0] - $c1[0]) * $t)
  $gg = [int]($c1[1] + ($c2[1] - $c1[1]) * $t)
  $b = [int]($c1[2] + ($c2[2] - $c1[2]) * $t)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($r, $gg, $b))
  $g.DrawLine($pen, $x, 0, $x, $H)
  $pen.Dispose()
}

# The white bell mark. android-icon-foreground.png is already the artwork on
# transparency (built for the adaptive icon), so it drops straight on.
$markPath = 'C:\Users\3ddie\laybell\assets\android-icon-foreground.png'
$mark = [System.Drawing.Image]::FromFile($markPath)
# That asset pads the mark into Android's safe zone (~42% of its canvas), so it
# is drawn oversized to land the bell itself at a readable ~260px.
$markDraw = 600
$markY = 10
$g.DrawImage($mark, [int](($W - $markDraw) / 2), $markY, $markDraw, $markDraw)

# Tagline, sitting just under the mark.
$font = New-Object System.Drawing.Font('Segoe UI', 66, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$text = 'The newest social media'
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = 'Center'
$fmt.LineAlignment = 'Center'

# A soft shadow keeps white type legible over the lighter end of the gradient.
$shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(75, 0, 0, 0))
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.DrawString($text, $font, $shadow, (New-Object System.Drawing.RectangleF(0, 503, $W, 96)), $fmt)
$g.DrawString($text, $font, $white, (New-Object System.Drawing.RectangleF(0, 500, $W, 96)), $fmt)

$out = 'C:\Users\3ddie\laybell\web\invite-card.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $mark.Dispose()
Write-Output "wrote $out ($W x $H)"
