import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".gitnexus/**", "coverage/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression[typeAnnotation.type='TSNeverKeyword']",
          message: "Do not cast to `never` — it silences client shape mismatches. Put the single documented cast in src/opencode-client.ts instead.",
        },
      ],
    },
  },
)
