This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Worker and Scheduler runtime safety

Production Worker and Scheduler processes fail closed before acquiring a runtime
role unless these five values are matching full Git SHAs:

- `SANDEAL_BUILD_MANIFEST_COMMIT`
- `SANDEAL_BUILD_COMMIT`
- `SANDEAL_RELEASE_ID`
- `GIT_COMMIT_SHA`
- `NEXT_PUBLIC_SANDEAL_RELEASE_ID`

For FileStorage job mutations, expensive scanning, serialization, temporary-file
writing, and backup preparation occur under the `automation-jobs` collection
lock without holding the Worker runtime-role fence. The fence is acquired only
for final authority validation and remains held through atomic replacement and
durable sync. A takeover before that boundary rejects the stale mutation and
removes its temporary file.

Slow or failed file transactions emit the payload-free
`file_storage_transaction_timing` diagnostic. It separates collection-lock wait,
preparation, runtime-authority wait/hold, and atomic-commit time. Run the focused
regression suite with:

```bash
npm run test:runtime-fence
```
