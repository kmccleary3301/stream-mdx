import { ShowcaseIndexClient } from "@/components/screens/showcase/showcase-index-client";
import { SHOWCASE_ITEMS } from "@/lib/showcase";

export const dynamic = "force-static";

export default function ShowcaseIndexPage() {
  return <ShowcaseIndexClient items={SHOWCASE_ITEMS} />;
}
