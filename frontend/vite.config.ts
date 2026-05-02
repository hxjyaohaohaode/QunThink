import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

const backendTarget = process.env.VITE_BACKEND_URL || 'http://localhost:3002'
const websocketTarget = backendTarget.replace(/^http/i, 'ws')

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'offline.html', 'pwa/apple-touch-icon-180x180.png'],
      manifest: {
        name: '群想 · 想，就聊出来',
        short_name: '群想',
        description: 'AI多角色群聊应用 — 想，就聊出来',
        theme_color: '#6C5CE7',
        background_color: '#0f0f1a',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        orientation: 'any',
        scope: '/',
        start_url: '/',
        lang: 'zh-CN',
        dir: 'ltr',
        categories: ['social', 'entertainment', 'utilities'],
        icons: [
          {
            src: 'pwa/icon-72x72.png',
            sizes: '72x72',
            type: 'image/png'
          },
          {
            src: 'pwa/icon-96x96.png',
            sizes: '96x96',
            type: 'image/png'
          },
          {
            src: 'pwa/icon-128x128.png',
            sizes: '128x128',
            type: 'image/png'
          },
          {
            src: 'pwa/icon-144x144.png',
            sizes: '144x144',
            type: 'image/png'
          },
          {
            src: 'pwa/icon-152x152.png',
            sizes: '152x152',
            type: 'image/png'
          },
          {
            src: 'pwa/icon-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa/icon-384x384.png',
            sizes: '384x384',
            type: 'image/png'
          },
          {
            src: 'pwa/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa/maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ],
        shortcuts: [
          {
            name: '新建群聊',
            short_name: '新建群聊',
            description: '创建一个新的AI群聊对话',
            url: '/?action=new-chat',
            icons: [{ src: 'pwa/icon-96x96.png', sizes: '96x96', type: 'image/png' }]
          },
          {
            name: '智能体',
            short_name: '智能体',
            description: '与AI智能体一对一对话',
            url: '/?action=agents',
            icons: [{ src: 'pwa/icon-96x96.png', sizes: '96x96', type: 'image/png' }]
          }
        ],
        share_target: {
          action: '/?action=share',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [
              {
                name: 'files',
                accept: ['image/*', 'text/*', 'application/pdf']
              }
            ]
          }
        }
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: 'offline.html',
        navigateFallbackDenylist: [/^\/api/, /^\/ws/, /\/assets\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'gstatic-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            urlPattern: /\/api\/tts\/audio\//i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tts-audio-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            urlPattern: /\/api\/files\/.*\/download/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'file-download-cache',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 3 },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      },
      devOptions: {
        enabled: false
      }
    })
  ],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared')
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react-dom') || id.includes('react/') || id.includes('scheduler')) {
              return 'react-core';
            }
            if (id.includes('react-router-dom') || id.includes('zustand') || id.includes('framer-motion') || id.includes('react-virtuoso')) {
              return 'ui-libs';
            }
            if (id.includes('react-markdown') || id.includes('remark-gfm') || id.includes('rehype-sanitize') || id.includes('prismjs')) {
              return 'markdown';
            }
            if (id.includes('axios') || id.includes('dayjs') || id.includes('clsx') || id.includes('tailwind-merge')) {
              return 'utils';
            }
          }
        }
      }
    }
  },
  server: {
    port: 3010,
    host: '0.0.0.0',
    fs: {
      allow: [path.resolve(__dirname, '..')]
    },
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true
      },
      '/ws': {
        target: websocketTarget,
        ws: true
      }
    }
  },
  preview: {
    host: '0.0.0.0',
    port: 10010,
    allowedHosts: ['all']
  }
})
