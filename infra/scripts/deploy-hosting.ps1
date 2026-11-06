<#
  Publica dashboard/dist no Firebase Hosting usando a API REST e o token do gcloud
  (evita `firebase login`). Faz o build do dashboard com BASE_PATH=/ antes de publicar.
  Uso: .\infra\scripts\deploy-hosting.ps1
#>
param([string]$Project = 'compiladores-512823', [string]$Site = 'compiladores-512823')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dist = Join-Path $root 'dashboard\dist'
# O vite usa base /Compiladores/ (GitHub Pages); no Hosting o site é servido na raiz.
Push-Location (Join-Path $root 'dashboard')
$env:BASE_PATH = '/'; npm run build; $code = $LASTEXITCODE; Remove-Item Env:BASE_PATH
Pop-Location
if ($code -ne 0 -or -not (Test-Path $dist)) { throw 'Build do dashboard falhou.' }
# Trava de segurança: nunca publicar o modo demonstração (sem login, dados fictícios).
if (Select-String -Path (Join-Path $dist 'assets\*.js') -Pattern 'Modo demonstra' -Quiet) {
  throw 'O bundle contém o modo demonstração (VITE_DEMO=true). Remova de dashboard/.env e refaça o build.'
}
if (-not (Select-String -Path (Join-Path $dist 'assets\*.js') -Pattern 'Entre com a conta Google' -Quiet)) {
  throw 'O bundle não contém a tela de login: abortando a publicação.'
}
$token = (gcloud auth print-access-token).Trim()
$h = @{ Authorization = "Bearer $token"; 'x-goog-user-project' = $Project }
$base = 'https://firebasehosting.googleapis.com/v1beta1'

$config = @{
  rewrites = @(
    @{ glob = '/api/**'; run = @{ serviceId = 'roboflow-api'; region = 'us-central1' } },
    @{ glob = '**'; path = '/index.html' })
  headers = @(
    @{ glob = '/api/**'; headers = @{ 'Cache-Control' = 'no-store' } },
    @{ glob = '/assets/**'; headers = @{ 'Cache-Control' = 'public, max-age=31536000, immutable' } },
    @{ glob = '**'; headers = @{ 'X-Content-Type-Options' = 'nosniff'; 'X-Frame-Options' = 'DENY'
        'Referrer-Policy' = 'no-referrer'; 'Strict-Transport-Security' = 'max-age=31536000; includeSubDomains' } })
}
$ver = Invoke-RestMethod -Method Post -Headers $h -ContentType 'application/json' `
  -Uri "$base/sites/$Site/versions" -Body (@{ config = $config } | ConvertTo-Json -Depth 8)

# gzip + sha256 de cada arquivo
$files = @{}; $blobs = @{}
Get-ChildItem $dist -Recurse -File | ForEach-Object {
  $rel = '/' + $_.FullName.Substring($dist.Length + 1).Replace('\', '/')
  $ms = New-Object IO.MemoryStream
  $gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionMode]::Compress, $true)
  $bytes = [IO.File]::ReadAllBytes($_.FullName); $gz.Write($bytes, 0, $bytes.Length); $gz.Dispose()
  $gzBytes = $ms.ToArray()
  $hash = ([BitConverter]::ToString([Security.Cryptography.SHA256]::HashData($gzBytes)) -replace '-', '').ToLower()
  $files[$rel] = $hash; $blobs[$hash] = $gzBytes
}
$pop = Invoke-RestMethod -Method Post -Headers $h -ContentType 'application/json' `
  -Uri "$base/$($ver.name):populateFiles" -Body (@{ files = $files } | ConvertTo-Json)
foreach ($hash in @($pop.uploadRequiredHashes)) {
  if (-not $hash) { continue }
  Invoke-RestMethod -Method Post -Headers $h -ContentType 'application/octet-stream' `
    -Uri "$($pop.uploadUrl)/$hash" -Body $blobs[$hash] | Out-Null
}
Invoke-RestMethod -Method Patch -Headers $h -ContentType 'application/json' `
  -Uri "$base/$($ver.name)?update_mask=status" -Body '{"status":"FINALIZED"}' | Out-Null
$rel = Invoke-RestMethod -Method Post -Headers $h -Uri "$base/sites/${Site}/releases?versionName=$($ver.name)"
Write-Host "Publicado: https://$Site.web.app  ($($rel.version.name))"
