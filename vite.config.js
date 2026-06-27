import { readFileSync } from 'fs'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const agsTarget = env.ACCELBYTE_BASE_URL || 'https://seal-chessags.prod.gamingservices.accelbyte.io'

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
      '/basic':        { target: agsTarget, changeOrigin: true },
      '/cloudsave':    { target: agsTarget, changeOrigin: true },
      '/friends':      { target: agsTarget, changeOrigin: true },
      '/presence':     { target: agsTarget, changeOrigin: true },
      '/lobby':        { target: agsTarget, changeOrigin: true, ws: true },
      '/social':       { target: agsTarget, changeOrigin: true },
      '/leaderboard':  { target: agsTarget, changeOrigin: true },
      '/match2':           { target: agsTarget, changeOrigin: true },
      '/session':          { target: agsTarget, changeOrigin: true },
      '/game-telemetry':   { target: agsTarget, changeOrigin: true },
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
    base: '/chess/',
    server: serverConfig,
    define: {
      __EXTEND_EMAIL_URL__: JSON.stringify(env.VITE_EXTEND_EMAIL_URL || ''),
    },
  }
})
