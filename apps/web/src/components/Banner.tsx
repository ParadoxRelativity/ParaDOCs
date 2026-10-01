/**
 * The ParaDOCs banner across the top of a sign-in card. It bleeds to the
 * card's edges, so the card must have p-6 and rounded-xl. Both pictures are
 * in the page, and the root `dark` class picks one, so the right one shows on
 * first paint and follows a theme change without a reload. It is decoration:
 * the card keeps its own heading for screen readers.
 */
export default function Banner() {
  const base = import.meta.env.BASE_URL;
  const picture = '-mx-6 -mt-6 mb-5 block aspect-[800/245] w-[calc(100%+3rem)] max-w-none rounded-t-xl';
  return (
    <div aria-hidden>
      <img src={`${base}banner-light.webp`} alt="" className={`${picture} dark:hidden`} />
      <img src={`${base}banner-dark.webp`} alt="" className={`${picture} hidden dark:block`} />
    </div>
  );
}
