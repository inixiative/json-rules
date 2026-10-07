import { defineConfig } from 'prisma/config';

// `migrate diff --from-empty` renders the provider's DDL from the datasource; it never connects.
export default defineConfig({
  schema: 'schema.prisma',
  datasource: { url: 'postgresql://localhost/unused' },
});
