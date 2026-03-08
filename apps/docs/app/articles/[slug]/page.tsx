import { redirect } from "next/navigation";

import { getAllGuideSlugs } from "@/lib/guides";

export function generateStaticParams() {
  return getAllGuideSlugs().map((slug) => ({ slug }));
}

export default async function ArticleSlugRedirect({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/docs/guides/${slug}`);
}
