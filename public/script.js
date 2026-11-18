// Progressive enhancement: thumbnails with motion show a still by default and play on hover / keyboard
// focus (pointer devices) or while scrolled into view (touch devices).
//   <video data-hover-play poster="still.jpg" preload="none">   played / paused
//   <img data-animated="clip.gif" src="still.jpg">              the GIF is swapped in / out
// Without JS, with "reduce motion", or with the browser's data-saver on, the still simply stays.
// Nothing is downloaded until a clip is first needed; later plays come from the browser cache.
(() => {
  if (navigator.connection?.saveData) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const items = [];

  for (const video of document.querySelectorAll('video[data-hover-play]')) {
    items.push({
      el: video,
      // play() rejects if it is interrupted by a pause() or blocked by the browser; both are harmless.
      play: () => video.play().catch(() => {}),
      stop: () => {
        video.pause();
        // load() resets the element, so the poster (the still) is shown again instead of frame 0 of the clip.
        if (video.readyState > 0) video.load();
      },
    });
  }

  for (const img of document.querySelectorAll('img[data-animated]')) {
    const still = img.getAttribute('src');
    items.push({
      el: img,
      play: () => img.setAttribute('src', img.dataset.animated),
      stop: () => img.setAttribute('src', still),
    });
  }

  if (!items.length) return;

  if (matchMedia('(hover: hover)').matches) {
    for (const { el, play, stop } of items) {
      const target = el.closest('a, li') ?? el;
      target.addEventListener('pointerenter', play);
      target.addEventListener('pointerleave', stop);
      target.addEventListener('focusin', play);
      target.addEventListener('focusout', stop);
    }
  } else {
    // `isIntersecting` is true for any overlap, so compare the ratio against the 0.6 threshold.
    const byElement = new Map(items.map((item) => [item.el, item]));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const item = byElement.get(entry.target);
          (entry.intersectionRatio >= 0.6 ? item.play : item.stop)();
        }
      },
      { threshold: [0, 0.6] },
    );
    items.forEach((item) => observer.observe(item.el));
  }
})();
