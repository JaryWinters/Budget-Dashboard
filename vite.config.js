import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/budget-dashboard/", // 👈 replace with your actual repo name
});