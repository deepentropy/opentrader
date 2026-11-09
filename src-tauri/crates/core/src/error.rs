/*
 * The error of a core call that a command answers with. The desktop app hands
 * its message to the window as the command's error string (unchanged, so the
 * window still reads the gateway code and ref in it); the web server also
 * picks the HTTP status from its kind.
 *
 * Deep internals keep `anyhow` or `ApiError`; they convert here, at the
 * boundary, keeping the gateway's code as the kind.
 */
use crate::data::gateway::{ApiError, ErrorCode};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// What was asked for does not exist (a symbol, a file, a filing).
    #[error("{0}")]
    NotFound(String),
    /// The gateway or another server failed, or could not be reached.
    #[error("{0}")]
    Upstream(String),
    /// The arguments cannot be served (an unknown name, an unreadable value).
    #[error("{0}")]
    InvalidInput(String),
    /// Too many requests: a later try may pass.
    #[error("{0}")]
    RateLimited(String),
    /// A file of this computer could not be read or written.
    #[error("{0}")]
    Io(String),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::NotFound(msg.into())
    }

    pub fn upstream(msg: impl Into<String>) -> Self {
        Self::Upstream(msg.into())
    }

    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::InvalidInput(msg.into())
    }

    pub fn io(msg: impl Into<String>) -> Self {
        Self::Io(msg.into())
    }

    /// The same kind with another message.
    fn with_message(&self, msg: String) -> Self {
        match self {
            Self::NotFound(_) => Self::NotFound(msg),
            Self::Upstream(_) => Self::Upstream(msg),
            Self::InvalidInput(_) => Self::InvalidInput(msg),
            Self::RateLimited(_) => Self::RateLimited(msg),
            Self::Io(_) => Self::Io(msg),
        }
    }
}

impl From<&ApiError> for Error {
    fn from(e: &ApiError) -> Self {
        let msg = e.to_string();
        match e.code {
            ErrorCode::NotFound => Self::NotFound(msg),
            ErrorCode::RateLimited => Self::RateLimited(msg),
            ErrorCode::BadRequest => Self::InvalidInput(msg),
            _ => Self::Upstream(msg),
        }
    }
}

impl From<ApiError> for Error {
    fn from(e: ApiError) -> Self {
        Self::from(&e)
    }
}

impl From<&std::io::Error> for Error {
    fn from(e: &std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => Self::NotFound(e.to_string()),
            _ => Self::Io(e.to_string()),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::from(&e)
    }
}

/// The kind of the gateway or file error inside, when there is one; the
/// message is the outermost one, as the commands always answered.
impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        let msg = e.to_string();
        let kind = e.chain().find_map(|c| {
            c.downcast_ref::<ApiError>().map(Self::from).or_else(|| c.downcast_ref::<std::io::Error>().map(Self::from))
        });
        match kind {
            Some(k) => k.with_message(msg),
            None => Self::Upstream(msg),
        }
    }
}

/// A desktop command's error is its message (the bindings type it `string`).
impl From<Error> for String {
    fn from(e: Error) -> Self {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;

    #[test]
    fn gateway_codes_pick_the_kind_and_keep_the_message() {
        let e = ApiError::from_answer("bars", StatusCode::NOT_FOUND, None, br#"{"code":"NOT_FOUND","error":"no","ref":"r1"}"#);
        assert_eq!(Error::from(e), Error::NotFound("bars: no (NOT_FOUND, ref r1)".into()));
        let e = ApiError::from_answer("bars", StatusCode::TOO_MANY_REQUESTS, None, b"");
        assert!(matches!(Error::from(e), Error::RateLimited(_)));
        let e = ApiError::transport("bars", "request failed");
        assert_eq!(Error::from(e), Error::Upstream("bars: request failed (NETWORK)".into()));
    }

    #[test]
    fn anyhow_keeps_its_outer_message_and_the_inner_kind() {
        let inner = ApiError::from_answer("ticker", StatusCode::NOT_FOUND, None, br#"{"code":"NOT_FOUND","error":"unknown"}"#);
        let e = anyhow::Error::from(inner);
        assert_eq!(Error::from(e), Error::NotFound("ticker: unknown (NOT_FOUND)".into()));
        let io = anyhow::Error::from(std::io::Error::other("disk full")).context("cache write");
        assert_eq!(Error::from(io), Error::Io("cache write".into()));
        assert_eq!(Error::from(anyhow::anyhow!("odd answer")), Error::Upstream("odd answer".into()));
        assert_eq!(String::from(Error::invalid("bad")), "bad");
    }
}
