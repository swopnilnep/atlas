import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { AUTHORED_ROUTES, GENERATED_DIR, fillAuthoredPage } from "./tools/lib/site.mjs";
import { loadViews } from "./tools/lib/views.mjs";

const root = import.meta.dirname;
const generatedDir = resolve(root, GENERATED_DIR);
const assetExists = (publicPath: string) => existsSync(join(root, "public", publicPath));
const routeFile = (route: string) => `${route.slice(1)}index.html`;
const inputName = (route: string) => route.replace(/^\/|\/$/g, "").replace(/\//g, "-") || "home";

function generatedRoutes(): string[] {
  const manifest = resolve(generatedDir, "routes.json");
  if (!existsSync(manifest)) throw new Error(`${GENERATED_DIR}/routes.json is missing. Run \`node tools/build-pages.mjs\` first (npm run build and npm run dev do this).`);
  return JSON.parse(readFileSync(manifest, "utf8")) as string[];
}

/**
 * Authored pages (/, /create/, /about/, /sources/) contain <!--atlas:*--> placeholders filled from views/*.json.
 * Generated pages live in .generated/ and are moved to their clean route in the output.
 */
function atlasPages(): Plugin {
  return {
    name: "atlas-pages",
    enforce: "post",
    config(_, { command }) {
      if (command !== "build") return;
      const input: Record<string, string> = {};
      for (const route of AUTHORED_ROUTES) input[inputName(route)] = resolve(root, routeFile(route));
      for (const route of generatedRoutes()) input[inputName(route)] = resolve(generatedDir, routeFile(route));
      return { build: { rollupOptions: { input } } };
    },
    transformIndexHtml: {
      order: "pre",
      async handler(html, context) {
        if (!html.includes("<!--atlas:")) return html;
        const path = `/${relative(root, context.filename).replace(/\\/g, "/").replace(/index\.html$/, "")}`;
        return fillAuthoredPage(html, path, await loadViews(resolve(root, "views")), assetExists);
      }
    },
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname === "/sitemap.xml") {
          request.url = `/${GENERATED_DIR}/sitemap.xml`;
        } else {
          const route = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
          if (route !== "/" && existsSync(resolve(generatedDir, routeFile(route)))) request.url = `/${GENERATED_DIR}${route}index.html${url.search}`;
        }
        next();
      });
    },
    generateBundle(_, bundle) {
      const prefix = `${GENERATED_DIR}/`;
      for (const [key, output] of Object.entries(bundle)) {
        if (output.type !== "asset" || !output.fileName.startsWith(prefix)) continue;
        delete bundle[key];
        this.emitFile({ type: "asset", fileName: output.fileName.slice(prefix.length), source: output.source });
      }
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: readFileSync(resolve(generatedDir, "sitemap.xml"), "utf8") });
    }
  };
}

export default defineConfig({
  plugins: [atlasPages()]
});
