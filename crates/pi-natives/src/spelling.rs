//! macOS spelling, word-completion, and autocorrection services.
//!
//! `AppleSpell` exposes UTF-16 ranges through [`NSSpellChecker`]. JavaScript
//! strings use the same indexing unit, so ranges cross N-API without remapping.
//! Other platforms expose the same API as an unavailable, no-op backend.
//! All `AppKit` work runs serially on one lazily spawned, dedicated spelling
//! thread so the singleton keeps a stable thread identity.

use napi_derive::napi;

/// A misspelled span measured in JavaScript/UTF-16 code units.
#[napi(object)]
pub struct SpellingRange {
	/// Inclusive UTF-16 start offset.
	pub start:  u32,
	/// UTF-16 length of the misspelled span.
	pub length: u32,
}

#[cfg(target_os = "macos")]
mod platform {
	use std::sync::LazyLock;

	use napi::{Error, Result, Status};
	use objc2::rc::Retained;
	use objc2_app_kit::NSSpellChecker;
	use objc2_foundation::{NSArray, NSRange, NSString};

	use super::SpellingRange;

	type Job = Box<dyn FnOnce() + Send + 'static>;

	static SPELLING_THREAD: LazyLock<flume::Sender<Job>> = LazyLock::new(|| {
		let (sender, receiver) = flume::unbounded::<Job>();
		std::thread::Builder::new()
			.name("pi-native-spelling".into())
			.spawn(move || {
				while let Ok(job) = receiver.recv() {
					job();
				}
			})
			.expect("failed to spawn the native spelling thread");
		sender
	});
	static APP_KIT_LOADED: LazyLock<bool> = LazyLock::new(|| {
		// SAFETY: AppKit documents `NSApplicationLoad` as process-global and
		// idempotent; `LazyLock` guarantees this process calls it at most once.
		unsafe { NSApplicationLoad() }
	});
	const NS_NOT_FOUND: usize = isize::MAX as usize;

	#[link(name = "AppKit", kind = "framework")]
	unsafe extern "C" {
		fn NSApplicationLoad() -> bool;
	}

	fn checker() -> Result<Retained<NSSpellChecker>> {
		if !*APP_KIT_LOADED {
			return Err(Error::new(Status::GenericFailure, "failed to initialize AppKit"));
		}
		let checker = NSSpellChecker::sharedSpellChecker();
		checker.setAutomaticallyIdentifiesLanguages(true);
		Ok(checker)
	}

	pub async fn run<T>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T>
	where
		T: Send + 'static,
	{
		let (reply, result) = flume::bounded(1);
		SPELLING_THREAD
			.send(Box::new(move || {
				let _ = reply.send(work());
			}))
			.map_err(|_| Error::new(Status::GenericFailure, "native spelling thread stopped"))?;
		result
			.recv_async()
			.await
			.map_err(|_| Error::new(Status::GenericFailure, "native spelling thread stopped"))?
	}

	fn ns_range(start: u32, length: u32) -> Result<NSRange> {
		Ok(NSRange {
			location: usize::try_from(start)
				.map_err(|_| Error::new(Status::InvalidArg, "spelling range start is too large"))?,
			length:   usize::try_from(length)
				.map_err(|_| Error::new(Status::InvalidArg, "spelling range length is too large"))?,
		})
	}

	pub fn check(text: &str) -> Result<Vec<SpellingRange>> {
		let checker = checker()?;
		let text = NSString::from_str(text);
		let text_len = text.length();
		let mut ranges = Vec::new();
		let mut offset = 0usize;
		while offset < text_len {
			let starting_at = isize::try_from(offset)
				.map_err(|_| Error::new(Status::InvalidArg, "spelling text is too large"))?;
			let range = checker.checkSpellingOfString_startingAt(&text, starting_at);
			if range.location >= NS_NOT_FOUND || range.length == 0 || range.location < offset {
				break;
			}
			ranges.push(SpellingRange {
				start:  u32::try_from(range.location)
					.map_err(|_| Error::new(Status::InvalidArg, "spelling range start is too large"))?,
				length: u32::try_from(range.length)
					.map_err(|_| Error::new(Status::InvalidArg, "spelling range length is too large"))?,
			});
			offset = range.location.saturating_add(range.length);
		}
		Ok(ranges)
	}

	fn strings(values: Option<Retained<NSArray<NSString>>>) -> Vec<String> {
		values
			.map(|values| values.iter().map(|value| value.to_string()).collect())
			.unwrap_or_default()
	}

	pub fn completions(text: &str, start: u32, length: u32) -> Result<Vec<String>> {
		let checker = checker()?;
		let text = NSString::from_str(text);
		let range = ns_range(start, length)?;
		let values = checker.completionsForPartialWordRange_inString_language_inSpellDocumentWithTag(
			range, &text, None, 0,
		);
		Ok(strings(values))
	}

	pub fn guesses(text: &str, start: u32, length: u32) -> Result<Vec<String>> {
		let checker = checker()?;
		let text = NSString::from_str(text);
		let range = ns_range(start, length)?;
		let values = checker
			.guessesForWordRange_inString_language_inSpellDocumentWithTag(range, &text, None, 0);
		Ok(strings(values))
	}

	pub fn correction(text: &str, start: u32, length: u32) -> Result<Option<String>> {
		let checker = checker()?;
		let text = NSString::from_str(text);
		let range = ns_range(start, length)?;
		let value = checker.correctionForWordRange_inString_language_inSpellDocumentWithTag(
			range,
			&text,
			&checker.language(),
			0,
		);
		Ok(value.map(|value| value.to_string()))
	}
}

/// Whether the host can use Apple's native spelling service.
#[napi(js_name = "macOSSpellCheckerAvailable")]
#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
pub fn macos_spell_checker_available() -> bool {
	cfg!(target_os = "macos")
}

/// Find every misspelled word using the active macOS dictionaries.
///
/// Returns an empty list when Apple's spelling service is unavailable.
/// On macOS, the check runs on the dedicated spelling thread.
#[napi(js_name = "macOSCheckSpelling")]
#[cfg_attr(
	not(target_os = "macos"),
	allow(clippy::unused_async, reason = "napi contract returns a Promise on every platform")
)]
pub async fn macos_check_spelling(text: String) -> napi::Result<Vec<SpellingRange>> {
	#[cfg(target_os = "macos")]
	{
		platform::run(move || platform::check(&text)).await
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = text;
		Ok(Vec::new())
	}
}

/// Return macOS dictionary completions for one partial-word range.
///
/// Returns an empty list when Apple's spelling service is unavailable.
/// On macOS, the lookup runs on the dedicated spelling thread.
#[napi(js_name = "macOSCompleteWord")]
#[cfg_attr(
	not(target_os = "macos"),
	allow(clippy::unused_async, reason = "napi contract returns a Promise on every platform")
)]
pub async fn macos_complete_word(
	text: String,
	start: u32,
	length: u32,
) -> napi::Result<Vec<String>> {
	#[cfg(target_os = "macos")]
	{
		platform::run(move || platform::completions(&text, start, length)).await
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = (text, start, length);
		Ok(Vec::new())
	}
}

/// Return the autocorrection macOS chooses for one completed-word range.
///
/// Returns `null` when no confident correction exists or the service is
/// unavailable.
/// On macOS, the lookup runs on the dedicated spelling thread.
#[napi(js_name = "macOSAutocorrectWord")]
#[cfg_attr(
	not(target_os = "macos"),
	allow(clippy::unused_async, reason = "napi contract returns a Promise on every platform")
)]
pub async fn macos_autocorrect_word(
	text: String,
	start: u32,
	length: u32,
) -> napi::Result<Option<String>> {
	#[cfg(target_os = "macos")]
	{
		platform::run(move || platform::correction(&text, start, length)).await
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = (text, start, length);
		Ok(None)
	}
}
/// Return macOS replacement guesses for one misspelled-word range.
///
/// Returns an empty list when Apple's spelling service is unavailable.
/// On macOS, the lookup runs on the dedicated spelling thread.
#[napi(js_name = "macOSSpellingGuesses")]
#[cfg_attr(
	not(target_os = "macos"),
	allow(clippy::unused_async, reason = "napi contract returns a Promise on every platform")
)]
pub async fn macos_spelling_guesses(
	text: String,
	start: u32,
	length: u32,
) -> napi::Result<Vec<String>> {
	#[cfg(target_os = "macos")]
	{
		platform::run(move || platform::guesses(&text, start, length)).await
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = (text, start, length);
		Ok(Vec::new())
	}
}
