// Settings
const API_KEY = '1d8a4iNH5IwOP8QhZ15RBHkoXWaR27cvwwqmQnQx';
const API_URL = `https://api.nasa.gov/planetary/apod?api_key=${API_KEY}&thumbs=true`;
// NASA is moving APOD to a new site. When the API sends a placeholder logo
// instead of the real entry, we load the same day from the new site.
const BACKUP_URL = 'https://science.nasa.gov/wp-json/wp/v2/apod-basic';
const SLIDE_TIME = 3000; // in milliseconds
const FIRST_DAY = new Date(1995, 5, 16); // first APOD ever posted
const BATCH_SIZE = 6; // pictures to load at once for the slideshow

// DOM elements
const image = document.querySelector('#apod-image');
const iframe = document.querySelector('#apod-iframe');
const video = document.querySelector('#apod-video');
const statusText = document.querySelector('#apod-status');
const dateEl = document.querySelector('#apod-date');
const titleEl = document.querySelector('#apod-title');
const creditEl = document.querySelector('#apod-credit');
const explanationEl = document.querySelector('#apod-explanation');
const prevBtn = document.querySelector('#prev-btn');
const nextBtn = document.querySelector('#next-btn');
const pauseBtn = document.querySelector('#pause-btn');
const progressBar = document.querySelector('#progress-bar');

const yearFrom = document.querySelector('#year-from');
const yearTo = document.querySelector('#year-to');
const yearRange = document.querySelector('#year-range');
const yearOutput = document.querySelector('#year-output');
const datePicker = document.querySelector('#pick-date');
const randomBtn = document.querySelector('#clear-date');

// State
const today = new Date();
const thisYear = today.getFullYear();
let years = { from: 1995, to: thisYear };
let pickedDate = ''; // YYYY-MM-DD, or empty for the random slideshow
let queue = [];
let timer = null;
let paused = false;
let loading = false;

// Converts HTML to plain text
function toText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent.replace(/^\s*Explanation:\s*/i, '').trim();
}

// Formats a date, e.g. October 12, 2026
function formatDate(dateString) {
  const date = new Date(dateString + 'T12:00:00');
  return date.toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Formats a date as YYYY-MM-DD for the API
function toApiDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

// Requests a smaller version of the image
function smallerImage(src) {
  if (!src.includes('assets.science.nasa.gov')) return src;
  const url = new URL(src);
  url.searchParams.set('w', '1600');
  url.searchParams.delete('h');
  return url.toString();
}

// Fetches a URL with a time limit
async function fetchWithTimeout(url, ms = 6000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// Checks if the API sent its placeholder instead of a real entry
function isPlaceholder(item) {
  return !item || item.title === 'NASA Science' || String(item.hdurl || item.url).includes('nasa-logo');
}

// Works out what to show for an entry: an image, an embedded video, or a video file
function getMedia(item) {
  if (item.media_type === 'image') {
    const src = item.hdurl || item.url || '';
    const isReal = src.includes('/apod/') && !src.includes('news-thumbnail');
    return isReal ? { type: 'image', src } : null;
  }

  // the API gives a YouTube or Vimeo link in url
  if (/youtube|vimeo/.test(item.url || '')) return { type: 'iframe', src: item.url };
  if (/\.mp4/.test(item.url || '')) return { type: 'video', src: item.url };

  // the new site puts the video inside its page HTML
  if (item.basic_html) {
    const doc = new DOMParser().parseFromString(item.basic_html, 'text/html');
    const frame = doc.querySelector('iframe[src]');
    if (frame) return { type: 'iframe', src: frame.getAttribute('src') };
    const file = doc.querySelector('video[src], video source[src]');
    if (file) return { type: 'video', src: file.getAttribute('src') };
  }

  return null;
}

// Loads one day from the backup site
async function loadFromBackup(dateString) {
  const id = dateString.slice(2).replaceAll('-', ''); // 2019-09-10 -> 190910
  const response = await fetchWithTimeout(`${BACKUP_URL}/${id}`);
  if (!response.ok) throw new Error(`Backup error ${response.status}`);
  return response.json();
}

// Loads one day: the API first, then the backup if the API sends a placeholder
async function loadDay(dateString) {
  try {
    const response = await fetchWithTimeout(`${API_URL}&date=${dateString}`);
    if (!response.ok) throw new Error(`NASA API error ${response.status}`);
    const item = await response.json();
    console.log('API:', item);
    if (!isPlaceholder(item)) return item;
  } catch (error) {
    console.log('API failed, using backup:', error);
  }
  return loadFromBackup(dateString);
}

// Picks a random day inside the year range
function randomDay() {
  const first = Math.max(new Date(years.from, 0, 1), FIRST_DAY);
  const last = Math.min(new Date(years.to, 11, 31), today);
  return toApiDate(new Date(first + Math.random() * (last - first)));
}

// Keeps entries with a real image inside the year range
function usablePictures(items) {
  return items.filter(item => {
    const year = Number(item.date.slice(0, 4));
    const media = getMedia(item);
    return media && media.type === 'image' && year >= years.from && year <= years.to;
  });
}

// Loads a batch of random pictures for the slideshow
async function loadPictures() {
  let items = [];

  try {
    const response = await fetchWithTimeout(`${API_URL}&count=${BATCH_SIZE}`);
    if (!response.ok) throw new Error(`NASA API error ${response.status}`);
    const data = await response.json();
    console.log('API:', data);
    items = usablePictures(data.filter(item => !isPlaceholder(item)));
  } catch (error) {
    console.log('API failed, using backup:', error);
  }

  // fill up the batch from the backup site
  if (items.length < 2) {
    const days = Array.from({ length: BATCH_SIZE }, randomDay);
    const results = await Promise.allSettled(days.map(loadFromBackup));
    const backupItems = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    items.push(...usablePictures(backupItems));
  }

  queue.push(...items);
}

// Shows an entry: image, embedded video or video file, plus its details
function render(item) {
  const media = getMedia(item);

  image.classList.remove('is-visible');
  iframe.hidden = true;
  iframe.src = 'about:blank';
  video.hidden = true;
  video.pause();
  image.hidden = false;

  dateEl.textContent = formatDate(item.date);
  dateEl.setAttribute('datetime', item.date);
  titleEl.textContent = item.title;
  creditEl.textContent = item.copyright ? `© ${toText(item.copyright)}` : 'Credit: NASA';
  explanationEl.textContent = toText(item.explanation);
  explanationEl.scrollTop = 0;

  if (!media) {
    statusText.textContent = 'This day has no picture or video to show.';
    return;
  }

  if (media.type === 'iframe') {
    image.hidden = true;
    iframe.src = media.src;
    iframe.hidden = false;
    statusText.textContent = '';
    return;
  }

  if (media.type === 'video') {
    image.hidden = true;
    video.src = media.src;
    video.hidden = false;
    statusText.textContent = '';
    return;
  }

  statusText.textContent = 'Loading…';
  image.onload = () => {
    statusText.textContent = '';
    image.classList.add('is-visible');
    restartTimer();
    preloadNext();
  };
  image.onerror = () => {
    if (pickedDate) statusText.textContent = 'The image for this day could not be loaded.';
    else showNext();
  };
  image.src = smallerImage(media.src);
  image.alt = toText(item.alt) || item.title;
}

// Shows the picture or video for the picked date
async function showDate() {
  clearTimeout(timer);
  image.classList.remove('is-visible');
  statusText.textContent = 'Loading…';

  try {
    render(await loadDay(pickedDate));
  } catch (error) {
    console.log(error);
    // today's entry may not be posted yet, so fall back to yesterday
    if (pickedDate === toApiDate(today)) return moveDate(-1);
    statusText.textContent = 'Could not load this day. Try another date.';
  }
}

// Shows the next picture in the random slideshow
async function showNext() {
  if (pickedDate) return showDate();
  if (loading) return;
  loading = true;
  clearTimeout(timer);

  try {
    for (let tries = 0; queue.length < 2 && tries < 3; tries++) {
      await loadPictures();
    }
  } catch (error) {
    console.log(error);
  }

  const item = queue.shift();
  loading = false;

  if (!item) {
    statusText.textContent = 'Could not load pictures. Check your connection and try again.';
    return;
  }

  render(item);
}

// Preloads the next image
function preloadNext() {
  if (!pickedDate && queue[0]) new Image().src = smallerImage(getMedia(queue[0]).src);
}

// Restarts the countdown and progress bar
function restartTimer() {
  clearTimeout(timer);

  progressBar.classList.remove('is-running');
  void progressBar.offsetWidth; // restarts the CSS animation

  if (paused || pickedDate) return;

  progressBar.classList.add('is-running');
  timer = setTimeout(showNext, SLIDE_TIME);
}

// Updates the year slider labels and track
function updateYears(changed) {
  let from = Number(yearFrom.value);
  let to = Number(yearTo.value);

  // keep the two handles from crossing
  if (from > to) {
    if (changed === yearFrom) from = to;
    else to = from;
    yearFrom.value = from;
    yearTo.value = to;
  }

  const span = thisYear - 1995;
  yearRange.style.setProperty('--from', `${((from - 1995) / span) * 100}%`);
  yearRange.style.setProperty('--to', `${((to - 1995) / span) * 100}%`);
  yearOutput.textContent = from === to ? `${from}` : `${from} to ${to}`;
}

// Switches between a picked date and the random slideshow
function setDate(value) {
  pickedDate = value;
  datePicker.value = value;
  randomBtn.hidden = !value;
  prevBtn.hidden = !value;
  pauseBtn.hidden = Boolean(value);
  nextBtn.textContent = value ? 'Next day' : 'Next picture';
  nextBtn.disabled = value === toApiDate(today);
  document.body.classList.toggle('is-date-mode', Boolean(value));
}

// Moves the picked date by a number of days
function moveDate(days) {
  const date = new Date(pickedDate + 'T12:00:00');
  date.setDate(date.getDate() + days);
  if (date > today || date < FIRST_DAY) return;
  setDate(toApiDate(date));
  showDate();
}

// Events
nextBtn.addEventListener('click', () => {
  if (pickedDate) moveDate(1);
  else showNext();
});

prevBtn.addEventListener('click', () => moveDate(-1));

pauseBtn.addEventListener('click', () => {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Play' : 'Pause';
  restartTimer();
});

yearFrom.addEventListener('input', () => updateYears(yearFrom));
yearTo.addEventListener('input', () => updateYears(yearTo));

// start a random slideshow in the chosen years when a handle is let go
[yearFrom, yearTo].forEach(slider => {
  slider.addEventListener('change', () => {
    years = { from: Number(yearFrom.value), to: Number(yearTo.value) };
    setDate('');
    queue = [];
    showNext();
  });
});

datePicker.addEventListener('change', () => {
  if (!datePicker.value) return;
  setDate(datePicker.value);
  showDate();
});

randomBtn.addEventListener('click', () => {
  setDate('');
  queue = [];
  showNext();
});

document.querySelector('#filters').addEventListener('submit', event => event.preventDefault());

// open on today's picture or video of the day
window.addEventListener('DOMContentLoaded', () => {
  yearFrom.max = thisYear;
  yearTo.max = thisYear;
  yearTo.value = thisYear;
  datePicker.max = toApiDate(today);
  updateYears();
  setDate(toApiDate(today));
  showDate();
});
