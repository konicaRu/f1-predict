$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dashboardRoot = Join-Path $PSScriptRoot 'tooling/understand-anything/understand-anything-plugin/packages/dashboard'
$viteEntry = Join-Path $dashboardRoot 'node_modules/vite/bin/vite.js'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'knowledge-graph.json'))) {
    throw 'Knowledge graph not found. Ask the agent to analyze this project with Understand Anything.'
}
if (-not (Test-Path -LiteralPath $viteEntry)) {
    throw 'Local Understand Anything installation is missing from .ua/tooling.'
}
$previousGraphDir = $env:GRAPH_DIR
$env:GRAPH_DIR = $projectRoot
Push-Location $dashboardRoot
try {
    & node $viteEntry --host 127.0.0.1
} finally {
    Pop-Location
    $env:GRAPH_DIR = $previousGraphDir
}
