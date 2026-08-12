import path from "path";
import fs from "fs";
import type { Core } from "@strapi/strapi";

export default {
  register() {},

  bootstrap({ strapi }: { strapi: Core.Strapi }) {
    strapi.server.routes([
      {
        method: "GET",
        path: "/",
        handler: async (ctx: any) => {
          const filePath = path.join(
            process.cwd(),
            "public",
            "frontend",
            "index.html"
          );

          if (fs.existsSync(filePath)) {
            ctx.type = "text/html";
            ctx.body = fs.readFileSync(filePath, "utf8");
          } else {
            ctx.body = "Frontend not found";
          }
        },
        config: {
          auth: false,
        },
      },
    ]);
  },
};