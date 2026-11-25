import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// The layer rule that keeps a framework-free core: only src/nextjs may import
// Next.js, and only src/react and src/nextjs may import React. A React Router
// or TanStack Start adapter can then reuse core and react unchanged.
const noNext = {
  group: ["next", "next/*"],
  message: "Only src/nextjs may import Next.js; keep core and react framework-free.",
};
const noReact = {
  group: ["react", "react/*", "react-dom", "react-dom/*"],
  message: "core has no UI: React belongs in src/react.",
};

export default tseslint.config(
  { ignores: ["dist"] },
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ["src/core/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [noNext, noReact, { group: ["../react/*", "../nextjs/*"], message: "core depends on nothing above it." }] }] },
  },
  {
    files: ["src/react/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [noNext, { group: ["../nextjs/*"], message: "react must not depend on the Next.js layer." }] }] },
  },
);
