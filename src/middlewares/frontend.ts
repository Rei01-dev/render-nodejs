// Ymar neg yum bolvol butsaah
// import path from "path";
// import fs from "fs";

// export default (
//   _config: unknown,
//   { strapi }: { strapi: any }
// ) => {
//   return async (ctx: any, next: any) => {
//     if (
//       ctx.method !== "GET" ||
//       ctx.path !== "/"
//     ) {
//       return next();
//     }

//     const indexPath = path.join(
//       strapi.dirs.static.public,
//       "frontend",
//       "index.html"
//     );

//     if (!fs.existsSync(indexPath)) {
//       return next();
//     }

//     ctx.type = "html";
//     ctx.body =
//       fs.createReadStream(indexPath);
//   };
// };




import path from "path";
import fs from "fs";

export default (
  _config: unknown,
  { strapi }: { strapi: any }
) => {
  return async (ctx: any, next: any) => {
    const isFrontendRoute =
      ctx.method === "GET" &&
      (
        ctx.path === "/" ||
        ctx.path.startsWith("/users/")
      );

    if (!isFrontendRoute) {
      return next();
    }

    const indexPath = path.join(
      strapi.dirs.static.public,
      "frontend",
      "index.html"
    );

    if (!fs.existsSync(indexPath)) {
      return next();
    }

    ctx.type = "html";
    ctx.body = fs.createReadStream(indexPath);
  };
};