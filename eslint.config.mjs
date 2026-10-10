import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    // ref/ holds third-party reference code we do not own and never ship; .omo/ is local
    // tooling evidence. Neither belongs in our lint surface.
    ignores: ["dist/**", "bundles/**", "node_modules/**", ".gitnexus/**", "coverage/**", "ref/**", ".omo/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression[typeAnnotation.type='TSNeverKeyword']",
          message: "Do not cast to `never`: it silences client shape mismatches. Put the single documented cast in src/opencode-client.ts instead.",
        },
      ],
    },
  },
)
