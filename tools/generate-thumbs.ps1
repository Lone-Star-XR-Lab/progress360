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

function Get-BaseImage([string]$dir){
  $files = Get-ChildItem -Path $dir -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
  $primary = $files | Where-Object { $_ -match "\\000-.*\.jpg$" } | Select-Object -First 1
  if($primary){ return $primary }
  $any = $files | Where-Object { $_ -match "\.jpg$" } | Select-Object -First 1
  return $any
}

function Get-ThumbPath([string]$basePath){
  $name = [System.IO.Path]::GetFileName($basePath)
  $dir = [System.IO.Path]::GetDirectoryName($basePath)
  $m = [regex]::Match($name, '^000-([^.]+)\.jpg$', 'IgnoreCase')
  if($m.Success){ $slug = $m.Groups[1].Value } else { $slug = ($name -replace '\\.jpg$', '').TrimStart('0','-') }
  return (Join-Path $dir ("000-$slug-thumb.jpg"))
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

