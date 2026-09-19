// MapLibre's CSP build (no blob: workers) ships without its own typings —
// its API is the regular package's.
declare module 'maplibre-gl/dist/maplibre-gl-csp.js' {
  export * from 'maplibre-gl';
}
