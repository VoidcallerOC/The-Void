import process from 'node:process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { mainnetNetworkGate } from './build/mainnet-network-gate.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), mainnetNetworkGate({ network: process.env.VITE_RELEASE_NETWORK })],
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      'artist-verification/**',
    ],
  },
  build: {
    rollupOptions: {
      // The site, the owner's mainnet deployment page (/owner-deploy) and, except in the mainnet build,
      // its separate Fuji test page (/fuji-rabby-test). Each page bundles only its own network's plans.
      input: {
        main: 'index.html',
        ownerDeploy: 'owner-deploy.html',
        ...(process.env.VITE_RELEASE_NETWORK === 'mainnet' ? {} : { fujiRabbyTest: 'fuji-rabby-test.html' }),
      },
      output: {
        // Split long-lived vendor code out of the app bundle so it caches
        // across deploys; route sections are split via React.lazy.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("lucide-react")) return "icons";
          if (id.includes("react")) return "react";
          return "vendor";
        },
      },
    },
  },
})
