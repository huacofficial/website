function initDriveSlideshow(containerId, folderId, apiKey, options = {}) {
	const intervalMs = options.intervalMs || 3000;
	const maxWidth = options.maxWidth || '800px';
	const height = options.height || '400px';

	const container = document.getElementById(containerId);
	container.style.maxWidth = maxWidth;
	container.style.height = height;
	container.style.margin = '0 auto';
	container.style.position = 'relative';
	container.style.overflow = 'hidden';
	container.style.borderRadius = '4px';
	container.style.background = '#111';
	container.innerHTML = '<p style="color:white; text-align:center; padding: 2em;">Loading photos...</p>';

	fetch(`https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents&key=${apiKey}&fields=files(id,name,mimeType,thumbnailLink)`)
		.then(res => res.json())
		.then(data => {
			container.innerHTML = '';

			if (!data.files) {
				container.innerHTML = '<p style="color:white; text-align:center; padding:2em;">Couldn\'t load photos.</p>';
				console.error('Drive API error:', data);
				return;
			}

			const images = data.files.filter(f => f.mimeType.startsWith('image/'));

			if (images.length === 0) {
				container.innerHTML = '<p style="color:white; text-align:center; padding:2em;">No photos yet.</p>';
				return;
			}

			let slideIndex = 0;

			images.forEach((file, i) => {
				const img = document.createElement('img');
				img.src = file.thumbnailLink.replace('=s220', '=s1000');
				img.style.width = '100%';
				img.style.height = '100%';
				img.style.objectFit = 'cover';
				img.style.display = i === 0 ? 'block' : 'none';
				img.style.cursor = 'pointer';
				img.className = 'drive-slide-' + containerId;
				container.appendChild(img);
			});

			const slides = document.querySelectorAll('.drive-slide-' + containerId);

			function showSlide(index) {
				slides[slideIndex].style.display = 'none';
				slideIndex = (index + slides.length) % slides.length;
				slides[slideIndex].style.display = 'block';
			}

			// Click image to advance
			slides.forEach(slide => {
				slide.addEventListener('click', () => showSlide(slideIndex + 1));
			});

			// Auto-advance timer
			let timer = setInterval(() => showSlide(slideIndex + 1), intervalMs);

			if (slides.length > 1) {
				// Prev arrow
				const prevBtn = document.createElement('button');
				prevBtn.innerHTML = '&#10094;';
				prevBtn.style.cssText = 'position:absolute; top:50%; left:10px; transform:translateY(-50%); background:rgba(0,0,0,0.5); color:white; border:none; font-size:1.5em; padding:0.3em 0.6em; cursor:pointer; border-radius:4px; z-index:2;';
				prevBtn.addEventListener('click', () => {
					showSlide(slideIndex - 1);
					clearInterval(timer);
					timer = setInterval(() => showSlide(slideIndex + 1), intervalMs);
				});
				container.appendChild(prevBtn);

				// Next arrow
				const nextBtn = document.createElement('button');
				nextBtn.innerHTML = '&#10095;';
				nextBtn.style.cssText = 'position:absolute; top:50%; right:10px; transform:translateY(-50%); background:rgba(0,0,0,0.5); color:white; border:none; font-size:1.5em; padding:0.3em 0.6em; cursor:pointer; border-radius:4px; z-index:2;';
				nextBtn.addEventListener('click', () => {
					showSlide(slideIndex + 1);
					clearInterval(timer);
					timer = setInterval(() => showSlide(slideIndex + 1), intervalMs);
				});
				container.appendChild(nextBtn);
			}
		})
		.catch(err => {
			container.innerHTML = '<p style="color:white; text-align:center; padding:2em;">Couldn\'t load photos.</p>';
			console.error(err);
		});
}