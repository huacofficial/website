(function () {
	'use strict';

	document.querySelectorAll('[data-launch-carousel]').forEach(function (carousel) {
		var track = carousel.querySelector('.onboarding-carousel__track');
		var slides = Array.from(track.children);
		var controls = carousel.querySelector('.onboarding-carousel__controls');
		var count = carousel.querySelector('[data-carousel-count]');
		var current = 0;
		var pending = false;

		function pauseVideos(exceptIndex) {
			slides.forEach(function (slide, index) {
				if (index !== exceptIndex) {
					slide.querySelectorAll('video').forEach(function (video) { video.pause(); });
				}
			});
		}

		function update() {
			var trackLeft = track.getBoundingClientRect().left;
			var nearest = Infinity;
			slides.forEach(function (slide, index) {
				var distance = Math.abs(slide.getBoundingClientRect().left - trackLeft);
				if (distance < nearest) {
					nearest = distance;
					current = index;
				}
			});
			var label = (current + 1) + ' / ' + slides.length;
			if (count.textContent !== label) count.textContent = label;
			pauseVideos(current);
			pending = false;
		}

		function move(direction) {
			update();
			var next = (current + direction + slides.length) % slides.length;
			pauseVideos(-1);
			var offset = slides[next].getBoundingClientRect().left - track.getBoundingClientRect().left;
			track.scrollTo({
				left: track.scrollLeft + offset,
				behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
			});
		}

		carousel.querySelector('[data-carousel-prev]').addEventListener('click', function () { move(-1); });
		carousel.querySelector('[data-carousel-next]').addEventListener('click', function () { move(1); });
		track.addEventListener('keydown', function (event) {
			if (event.target.closest('video')) return;
			if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
				event.preventDefault();
				move(event.key === 'ArrowLeft' ? -1 : 1);
			}
		});
		track.addEventListener('scroll', function () {
			if (!pending) {
				pending = true;
				window.requestAnimationFrame(update);
			}
		}, { passive: true });
		window.addEventListener('resize', update);
		controls.hidden = slides.length < 2;
		update();
	});
}());
