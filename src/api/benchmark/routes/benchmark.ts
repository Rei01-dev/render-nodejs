// export default {
export default {
  routes: [
    {
      method: "POST",
      path: "/benchmark/run/strapi-insert",
      handler: "benchmark.strapiInsert",
      config: {
        auth: false,
      },
    },

    {
      method: "GET",
      path: "/benchmark/history",
      handler: "benchmark.history",
      config: {
        auth: false,
      },
    },

    {
      method: "GET",
      path: "/benchmark/users",
      handler: "benchmark.users",
      config: {
        auth: false,
      },
    },

    {
      method: "POST",
      path: "/benchmark/run/mysql",
      handler: "benchmark.mysqlInsert",
      config: {
        auth: false,
      },
    },


    {
      method: "POST",
      path: "/benchmark/run/page-load",
      handler: "benchmark.pageLoad",
      config: {
        auth: false,
      },
    },

    // If that doesn't work just delete and rebuild
    {
      method: "GET",
      path: "/benchmark/users/:id",
      handler: "benchmark.userById",
      config: {
        auth: false,
      },
    },

  ],
};