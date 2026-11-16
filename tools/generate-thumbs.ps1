param(
  [string]$Root = "assets",
  [int]$Width = 1200,
  [int]$Quality = 74,
  [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-JpegEncoder {
  $encoders = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()
  return $encoders | Where-Object { $_.MimeType -eq 'image/jpeg' }
}

function Save-Jpeg($bitmap, [string]$outPath, [int]$quality){
  $jpeg = Get-JpegEncoder
  $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $qParam = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [int64]$quality)
  $ep.Param[0] = $qParam
  $dir = Split-Path -Parent $outPath
  if(-not (Test-Path $dir)){ [void](New-Item -ItemType Directory -Path $dir) }
  $bitmap.Save($outPath, $jpeg, $ep)
  $ep.Dispose()
}

# Same ordering as stages.js: numbered (000-*) first, then dated (20260216_*, 2026-02-16_*), then anything else
function Get-BaseImage([string]$dir){
  $files = Get-ChildItem -Path $dir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '\.jpe?g$' -and $_.Name -notmatch '-thumb\.jpe?g$' } |
    Sort-Object Name | Select-Object -ExpandProperty Name
  $numbered = $files | Where-Object { $_ -match '^\d{3}-' -and $_ -notmatch '^999-' } | Select-Object -First 1
  if($numbered){ return (Join-Path $dir $numbered) }
  $dated = $files | Where-Object { $_ -match '^(?:[a-z]{2,6}[_-])?(19|20)\d{2}-?\d{2}-?\d{2}(?!\d)' } |
    Sort-Object { ($_ -replace '^(?:[a-z]{2,6}[_-])?((19|20)\d{2})-?(\d{2})-?(\d{2}).*$', '$1$3$4') } | Select-Object -First 1
  if($dated){ return (Join-Path $dir $dated) }
  $any = $files | Select-Object -First 1
  if($any){ return (Join-Path $dir $any) }
  return $null
}

# 000-kitchen.jpg -> 000-kitchen-thumb.jpg, 20260216_C210.jpg -> 20260216_C210-thumb.jpg
function Get-ThumbPath([string]$basePath){
  return ($basePath -replace '\.jpe?g$', '-thumb.jpg')
}

Add-Type -AssemblyName System.Drawing

$rootPath = Resolve-Path -LiteralPath $Root
$dirs = Get-ChildItem -Path $rootPath -Directory -ErrorAction SilentlyContinue

$created = 0; $skipped = 0
foreach($d in $dirs){
  try{
    $base = Get-BaseImage $d.FullName
    if(-not $base){ Write-Host "Skip: $($d.Name) (no jpg)"; $skipped++; continue }
    $out = Get-ThumbPath $base
    if(Test-Path $out){ Write-Host "Skip: $($d.Name) (exists)"; $skipped++; continue }
    if($WhatIf){ Write-Host "Would create: $out"; $skipped++; continue }

    $img = [System.Drawing.Image]::FromFile($base)
    try{
      $w0 = [double]$img.Width; $h0 = [double]$img.Height
      if($w0 -le 0 -or $h0 -le 0){ throw "Invalid image dimensions" }
      $scale = [Math]::Min(1.0, $Width / $w0)
      $w = [int][Math]::Max(1, [Math]::Round($w0 * $scale))
      $h = [int][Math]::Max(1, [Math]::Round($h0 * $scale))
      $bmp = New-Object System.Drawing.Bitmap($w, $h)
      try{
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try{
          $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
          $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
          $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
          $g.DrawImage($img, 0, 0, $w, $h)
        } finally { $g.Dispose() }
        Save-Jpeg -bitmap $bmp -outPath $out -quality $Quality
      } finally { $bmp.Dispose() }
    } finally { $img.Dispose() }
    $created++
    Write-Host "Created: $out"
  }catch{
    Write-Warning "Error processing '$($d.FullName)': $($_.Exception.Message)"
    $skipped++
  }
}

Write-Host "Done. Created $created, skipped $skipped."

