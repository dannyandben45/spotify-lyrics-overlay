/** Human-readable labels for lyrics providers shown in the UI */
const SOURCE_LABELS: Record<string, string> = {
  lrclib: 'LRCLIB',
  netease: 'NetEase Cloud Music',
  'lrc.cx': 'LrcAPI',
  'lyrics.ovh': 'lyrics.ovh',
}

export const formatLyricsSource = (source: string | null | undefined) => {
  if (!source) return null
  return SOURCE_LABELS[source] ?? source
}

export const lyricsSourceAttribution = (source: string | null | undefined) => {
  const label = formatLyricsSource(source)
  if (!label) return null
  return `Lyrics via ${label}`
}
