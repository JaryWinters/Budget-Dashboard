import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/Budget-Dashboard/", // 👈 replace with your actual repo name
});
