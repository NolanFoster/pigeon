use aes_gcm::{aead::Aead, Aes128Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hkdf::Hkdf;
use p256::{
    ecdh::EphemeralSecret,
    elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint},
    EncodedPoint, PublicKey,
};
use sha2::Sha256;
use worker::*;

/// Encrypt a Web Push payload per RFC 8291 (aes128gcm content encoding).
///
/// Returns the complete encrypted body ready to POST to the push endpoint.
pub fn encrypt_payload(payload: &[u8], p256dh_b64: &str, auth_b64: &str) -> Result<Vec<u8>> {
    // Decode subscriber keys
    let ua_public_bytes = URL_SAFE_NO_PAD
        .decode(p256dh_b64)
        .map_err(|_| Error::RustError("invalid p256dh".into()))?;
    let auth_secret = URL_SAFE_NO_PAD
        .decode(auth_b64)
        .map_err(|_| Error::RustError("invalid auth secret".into()))?;

    let ua_public_point = EncodedPoint::from_bytes(&ua_public_bytes)
        .map_err(|_| Error::RustError("invalid p256dh point".into()))?;
    let ua_public_key = PublicKey::from_encoded_point(&ua_public_point)
        .into_option()
        .ok_or_else(|| Error::RustError("invalid p256dh public key".into()))?;

    // Generate ephemeral key pair
    let mut rng = rand::thread_rng();
    let ephemeral_secret = EphemeralSecret::random(&mut rng);
    let ephemeral_public = PublicKey::from(&ephemeral_secret);
    let ephemeral_public_bytes = ephemeral_public.to_encoded_point(false);

    // ECDH shared secret
    let shared_secret = ephemeral_secret.diffie_hellman(&ua_public_key);

    // Derive IKM per RFC 8291 Section 3.4
    // info = "WebPush: info\0" || ua_public (65 bytes) || as_public (65 bytes)
    let mut ikm_info = Vec::with_capacity(144);
    ikm_info.extend_from_slice(b"WebPush: info\0");
    ikm_info.extend_from_slice(ua_public_point.as_bytes());
    ikm_info.extend_from_slice(ephemeral_public_bytes.as_bytes());

    let hkdf_auth = Hkdf::<Sha256>::new(Some(&auth_secret), shared_secret.raw_secret_bytes());
    let mut ikm = [0u8; 32];
    hkdf_auth
        .expand(&ikm_info, &mut ikm)
        .map_err(|_| Error::RustError("HKDF expand failed for IKM".into()))?;

    // Generate random salt
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt)
        .map_err(|_| Error::RustError("getrandom failed".into()))?;

    // Derive CEK and nonce per RFC 8188
    let hkdf_content = Hkdf::<Sha256>::new(Some(&salt), &ikm);

    let mut cek = [0u8; 16];
    hkdf_content
        .expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| Error::RustError("HKDF expand failed for CEK".into()))?;

    let mut nonce_bytes = [0u8; 12];
    hkdf_content
        .expand(b"Content-Encoding: nonce\0", &mut nonce_bytes)
        .map_err(|_| Error::RustError("HKDF expand failed for nonce".into()))?;

    // Pad plaintext with delimiter byte (0x02 = final record)
    let mut padded = Vec::with_capacity(payload.len() + 1);
    padded.extend_from_slice(payload);
    padded.push(0x02);

    // Encrypt with AES-128-GCM
    let cipher = Aes128Gcm::new_from_slice(&cek)
        .map_err(|_| Error::RustError("AES key init failed".into()))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, padded.as_ref())
        .map_err(|_| Error::RustError("AES-GCM encryption failed".into()))?;

    // Build aes128gcm body: salt(16) || rs(4) || idlen(1) || keyid(65) || ciphertext
    // rs = record size = padded plaintext + 16 byte tag = ciphertext.len()
    let record_size: u32 = ciphertext.len() as u32;
    let key_id = ephemeral_public_bytes.as_bytes();

    let mut body = Vec::with_capacity(86 + ciphertext.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&record_size.to_be_bytes());
    body.push(key_id.len() as u8); // 65
    body.extend_from_slice(key_id);
    body.extend_from_slice(&ciphertext);

    Ok(body)
}
