// The tsconfig of the Web Chat app, read when a registry item adds Web Chat to
// an existing project. The rest of the app comes from the registry item.

export const WEB_APP_TEMPLATE_FILES = {
  "tsconfig.json":
    '{\n  "$schema": "https://json.schemastore.org/tsconfig",\n  "compilerOptions": {\n    "target": "ES2017",\n    "lib": ["dom", "dom.iterable", "esnext"],\n    "allowJs": true,\n    "skipLibCheck": true,\n    "strict": true,\n    "noEmit": true,\n    "esModuleInterop": true,\n    "module": "esnext",\n    "moduleResolution": "Bundler",\n    "resolveJsonModule": true,\n    "isolatedModules": true,\n    "jsx": "react-jsx",\n    "incremental": true,\n    "plugins": [\n      {\n        "name": "next"\n      }\n    ],\n    "paths": {\n      "@/*": ["./*"]\n    }\n  },\n  "include": [\n    "next-env.d.ts",\n    "**/*.ts",\n    "**/*.tsx",\n    ".next/types/**/*.ts",\n    ".next/dev/types/**/*.ts"\n  ],\n  "exclude": ["node_modules"]\n}\n',
} as const;
