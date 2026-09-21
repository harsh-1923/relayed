import Image from 'next/image';
import { Manrope, Syncopate } from 'next/font/google';

import footerImage from '@/assets/footer.jpg';
import { FooterDither } from './footer-dither';

const manrope = Manrope({
  weight: '400',
  subsets: ['latin'],
  display: 'swap',
});

const syncopate = Syncopate({
  weight: '700',
  subsets: ['latin'],
  display: 'swap',
});

export function SiteFooter() {
  return (
    <footer className="relative h-svh min-h-[52rem] w-full shrink-0 overflow-hidden">
      {/* Decorative, so no alt text — it carries no information a reader
          would otherwise miss. `fill` needs a positioned ancestor, which is
          the `relative` above. */}
      <FooterDither>
        <Image
          src={footerImage}
          alt=""
          fill
          sizes="100vw"
          placeholder="blur"
          className="object-cover"
        />
      </FooterDither>
      <section
        aria-label="What we are building"
        className={`${manrope.className} relative z-10 mx-auto grid max-w-[1080px] gap-6 px-6 pt-10 text-[18px] leading-7 font-normal text-[#29251f] sm:px-10 sm:pt-16 md:grid-cols-2 md:gap-16 md:pt-[12svh]`}
      >
        <p>
          The next workspace won’t be human-first or agent-first. It will be built for
          both. We believe people and AI agents should work as equal participants,
          bringing different strengths to a common goal.
        </p>
        <p>
          We’re designing Relay around the interactions that make this possible:
          handing work over, making decisions, and staying in context. Our aim is an
          interface that makes collaboration easier and the work itself better.
        </p>
      </section>
      <p
        className={`${syncopate.className} absolute bottom-7 left-1/2 z-10 -translate-x-1/2 text-[48px] leading-[normal] tracking-normal whitespace-nowrap text-white sm:bottom-10`}
      >
        relay
      </p>
    </footer>
  );
}
