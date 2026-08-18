# src/toPrisma/utils.ts

## buildNestedFilter

> `export const buildNestedFilter = (field: string, filter: unknown): PrismaWhere => {`

Build a nested Prisma filter from a dot-notation field path.

In Prisma, dot-notation always means relation traversal (unlike toSql where
dots mean JSON path). Each segment wraps the next from the inside out.

@example
buildNestedFilter('status', { equals: 'active' })
// → { status: { equals: 'active' } }

buildNestedFilter('user.profile.bio', { contains: 'hello' })
// → { user: { profile: { bio: { contains: 'hello' } } } }
