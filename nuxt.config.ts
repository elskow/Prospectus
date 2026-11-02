import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";

export default defineNuxtConfig({
  app: {
    head: {
      title: "Prospectus",
      link: [{ rel: "icon", type: "image/svg+xml", href: "/prospectus-icon.svg" }],
    },
  },
  compatibilityDate: "2026-10-01",
  devtools: { enabled: false },
  modules: ["shadcn-nuxt"],
  shadcn: {
    prefix: "",
    componentDir: "~/components/ui",
  },
  css: ["~/assets/css/tailwind.css"],
  alias: {
    "@src": fileURLToPath(new URL("./src", import.meta.url)),
    "@server": fileURLToPath(new URL("./server", import.meta.url)),
    "@app": fileURLToPath(new URL("./app", import.meta.url)),
  },
  vite: {
    plugins: [tailwindcss()],
  },
  nitro: {
    preset: "bun",
  } as never,
  future: {
    compatibilityVersion: 4,
  },
  srcDir: "app/",
  runtimeConfig: {
    databaseUrl: process.env.DATABASE_URL,
  },
});
