let reduceMotionQuery = null;

export function reducedMotion() {
  reduceMotionQuery ??= matchMedia('(prefers-reduced-motion: reduce)');
  return reduceMotionQuery.matches;
}

export function marqueeDistance(scrollWidth, clientWidth) {
  if (clientWidth <= 0) return 0;
  const d = scrollWidth - clientWidth;
  return d > 0 ? d : 0;
}

export function marqueeKeyframes(distance, speed = 35, lead = 0.5, tail = 0.8) {
  const scroll = distance / speed;
  const total = lead + scroll + tail + scroll;
  const keyframes = [
    { transform: 'translateX(0)', offset: 0 },
    { transform: 'translateX(0)', offset: lead / total },
    { transform: `translateX(${-distance}px)`, offset: (lead + scroll) / total },
    { transform: `translateX(${-distance}px)`, offset: (lead + scroll + tail) / total },
    { transform: 'translateX(0)', offset: 1 },
  ];
  return { keyframes, duration: total * 1000 };
}

export function stopMarquee(li) {
  if (li._mqAnim) { li._mqAnim.cancel(); li._mqAnim = null; }
  li.classList.remove('marqueeing');
}

export function startMarquee(li, track) {
  if (reducedMotion() || li._mqAnim) return;
  // the track carries the transform while its parent stays a static,
  // always-clipped viewport, so sliding text can never paint past it
  const distance = marqueeDistance(track.scrollWidth, track.clientWidth);
  if (distance <= 0) return;
  li.classList.add('marqueeing');
  const { keyframes, duration } = marqueeKeyframes(distance);
  li._mqAnim = track.animate(keyframes, { duration, iterations: Infinity, easing: 'linear' });
}
