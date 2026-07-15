import { copyFileSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const agsTarget = env.ACCELBYTE_BASE_URL || 'https://seal-chessags.prod.gamingservices.accelbyte.io'
  // Capacitor loads dist/ from local files (capacitor://localhost), so assets
  // must use relative paths. GitHub Pages serves under the /chess/ subpath.
  const base = env.VITE_BUILD_TARGET === 'capacitor' ? './' : '/chess/'

  const serverConfig = {
    host: '0.0.0.0',
    port: 8808,
    hmr: {
      protocol: 'wss',
      host: 'localhost',
      clientPort: 8808,
    },
    strictPort: true,
    proxy: {
      '/iam':          { target: agsTarget, changeOrigin: true },
      '/agreement':    { target: agsTarget, changeOrigin: true },
      '/basic':        { target: agsTarget, changeOrigin: true },
      '/cloudsave':    { target: agsTarget, changeOrigin: true },
      '/friends':      { target: agsTarget, changeOrigin: true },
      '/presence':     { target: agsTarget, changeOrigin: true },
      '/lobby':        { target: agsTarget, changeOrigin: true, ws: true },
      '/chat':         { target: agsTarget, changeOrigin: true },
      '/social':       { target: agsTarget, changeOrigin: true },
      '/group':        { target: agsTarget, changeOrigin: true },
      '/leaderboard':  { target: agsTarget, changeOrigin: true },
      '/match2':           { target: agsTarget, changeOrigin: true },
      '/session':          { target: agsTarget, changeOrigin: true },
      '/game-telemetry':   { target: agsTarget, changeOrigin: true },
      '/achievement':      { target: agsTarget, changeOrigin: true },
      // coin-store.js posts orders straight to agsBaseURL (= window.location.origin
      // in DEV) rather than through the SDK, same as the other raw-fetch calls
      // above — needs its own proxy entry or cosmetic purchases 404 in local dev.
      '/platform':     { target: agsTarget, changeOrigin: true },
      '/extend':       { target: env.EXTEND_EMAIL_URL || 'http://localhost:8080', changeOrigin: true, rewrite: path => path.replace(/^\/extend/, '') },
    },
  }

  // Only load SSL certs in dev — they don't exist in CI
  if (command === 'serve') {
    serverConfig.https = {
      key:  readFileSync('./key.pem'),
      cert: readFileSync('./cert.pem'),
    }
  }

  return {
    base,
    plugins: [
      {
        name: 'copy-worker-game-scripts',
        writeBundle(outputOptions) {
          const outDir = outputOptions.dir || resolve(process.cwd(), 'dist')
          for (const file of ['chess-engine.js', 'ai-engine.js', 'analysis-worker.js']) {
            copyFileSync(resolve(process.cwd(), file), resolve(outDir, file))
          }
        },
      },
    ],
    server: serverConfig,
    define: {
      __EXTEND_EMAIL_URL__: JSON.stringify(env.VITE_EXTEND_EMAIL_URL || ''),
    },
  }
})
