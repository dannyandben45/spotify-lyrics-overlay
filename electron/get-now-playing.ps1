$ErrorActionPreference = 'Stop'

function Write-Utf8JsonBase64($Object) {
  $json = $Object | ConvertTo-Json -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  [Console]::Out.Write([Convert]::ToBase64String($bytes))
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]

  $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } |
    Select-Object -First 1

  if (-not $asTaskGeneric) {
    throw 'Unable to bind WinRT AsTask helper'
  }

  function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
  }

  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $sessions = @($manager.GetSessions())

  if ($sessions.Count -eq 0) {
    Write-Utf8JsonBase64 @{ ok = $true; playing = $false }
    exit 0
  }

  $session = $sessions |
    Where-Object { $_.SourceAppUserModelId -match 'Spotify' } |
    Select-Object -First 1

  if (-not $session) {
    $session = $manager.GetCurrentSession()
  }

  if (-not $session) {
    Write-Utf8JsonBase64 @{ ok = $true; playing = $false }
    exit 0
  }

  $info = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $timeline = $session.GetTimelineProperties()
  $playback = $session.GetPlaybackInfo()
  $isPlaying = ([int]$playback.PlaybackStatus -eq 4)

  $durationMs = [math]::Max(0, [int64](($timeline.EndTime - $timeline.StartTime).TotalMilliseconds))
  # Spotify often freezes Position; extrapolate from LastUpdatedTime while playing
  $positionMs = [math]::Max(0, [double]$timeline.Position.TotalMilliseconds)
  try {
    $lastUpdated = [DateTimeOffset]$timeline.LastUpdatedTime
    $ageMs = ([DateTimeOffset]::Now - $lastUpdated).TotalMilliseconds
    if ($isPlaying -and $ageMs -gt 0 -and $ageMs -lt 120000) {
      $positionMs += $ageMs
    }
  } catch {
    # keep raw position
  }

  $positionMs = [math]::Max(0, [int64]$positionMs)
  if ($durationMs -gt 0 -and $positionMs -gt $durationMs) {
    $positionMs = $durationMs
  }

  Write-Utf8JsonBase64 @{
    ok = $true
    playing = $true
    title = [string]$info.Title
    artist = [string]$info.Artist
    album = [string]$info.AlbumTitle
    isPlaying = $isPlaying
    positionMs = $positionMs
    durationMs = $durationMs
    appId = [string]$session.SourceAppUserModelId
  }
}
catch {
  Write-Utf8JsonBase64 @{
    ok = $false
    playing = $false
    error = $_.Exception.Message
  }
  exit 0
}
