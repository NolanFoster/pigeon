use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use p256::ecdsa::{signature::Signer, Signature, SigningKey, VerifyingKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use worker::*;

/// Build the VAPID Authorization header value.
/// Format: `vapid t=<jwt>, k=<base64url-uncompressed-pubkey>`
pub fn build_vapid_header(
    endpoint: &str,
    private_key_b64: &str,
    _public_key_b64: &str,
    subject: &str,
) -> Result<String> {
    // Extract the origin from the push endpoint URL
    let url: Url = endpoint
        .parse()
        .map_err(|_| Error::RustError("invalid endpoint URL".into()))?;
    let audience = url.origin().ascii_serialization();

    // Current time + 12 hours
    let now = (Date::now().as_millis() / 1000) as u64;
    let exp = now + 12 * 3600;

    // Build JWT header and payload
    let header = URL_SAFE_NO_PAD.encode(r#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = serde_json::json!({
        "aud": audience,
        "exp": exp,
        "sub": subject
    });
    let payload = URL_SAFE_NO_PAD.encode(claims.to_string().as_bytes());

    let signing_input = format!("{}.{}", header, payload);

    // Decode the private key (raw 32-byte scalar) and sign
    let key_bytes = URL_SAFE_NO_PAD
        .decode(private_key_b64)
        .map_err(|_| Error::RustError("invalid VAPID private key base64".into()))?;
    let signing_key = SigningKey::from_bytes((&key_bytes[..]).into())
        .map_err(|_| Error::RustError("invalid VAPID private key".into()))?;

    // Derive the public key from the private key (guarantees consistency)
    let verifying_key = VerifyingKey::from(&signing_key);
    let public_point = verifying_key.to_encoded_point(false); // uncompressed, 65 bytes
    let public_key_b64 = URL_SAFE_NO_PAD.encode(public_point.as_bytes());

    let signature: Signature = signing_key.sign(signing_input.as_bytes());
    let sig_b64 = URL_SAFE_NO_PAD.encode(signature.to_bytes());

    Ok(format!(
        "vapid t={}.{}, k={}",
        signing_input, sig_b64, public_key_b64
    ))
}

/// Derive the public key from the private key for serving to browsers.
pub fn get_public_key_b64(private_key_b64: &str) -> Result<String> {
    let key_bytes = URL_SAFE_NO_PAD
        .decode(private_key_b64)
        .map_err(|_| Error::RustError("invalid VAPID private key base64".into()))?;
    let signing_key = SigningKey::from_bytes((&key_bytes[..]).into())
        .map_err(|_| Error::RustError("invalid VAPID private key".into()))?;
    let verifying_key = VerifyingKey::from(&signing_key);
    let public_point = verifying_key.to_encoded_point(false);
    Ok(URL_SAFE_NO_PAD.encode(public_point.as_bytes()))
}
