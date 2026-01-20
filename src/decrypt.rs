use aes::Aes128;
use aes::Aes256;
use aes::cipher::{BlockDecryptMut, KeyIvInit, StreamCipher};
use base64::Engine;
use cbc::Decryptor as CbcDecryptor;
use ctr::Ctr128BE;
use tracing::debug;

const MASTER_KEY: &str = env!("TIDAL_MASTER_DECRYPTION_KEY");

struct DecryptedKey {
    key: Vec<u8>,
    nonce: Vec<u8>,
}

#[derive(Clone)]
pub struct FlacDecryptor {
    key: Vec<u8>,
    nonce: Vec<u8>,
}

impl FlacDecryptor {
    fn decrypt_key_id(key_id_b64: &str) -> anyhow::Result<DecryptedKey> {
        let master_key = base64::engine::general_purpose::STANDARD
            .decode(MASTER_KEY)
            .map_err(|e| anyhow::anyhow!("Failed to decode master key: {}", e))?;

        let key_id_bytes = base64::engine::general_purpose::STANDARD
            .decode(key_id_b64)
            .map_err(|e| anyhow::anyhow!("Failed to decode key ID: {}", e))?;

        if key_id_bytes.len() < 16 {
            anyhow::bail!("Key ID too short: need at least 16 bytes for IV");
        }

        let iv = &key_id_bytes[..16];
        let encrypted_key = &key_id_bytes[16..];

        debug!(
            "Decrypting key ID with AES-256-CBC (IV: {} bytes, encrypted: {} bytes)",
            iv.len(),
            encrypted_key.len()
        );

        type Aes256CbcDec = CbcDecryptor<Aes256>;
        let decryptor = Aes256CbcDec::new_from_slices(&master_key, iv)
            .map_err(|e| anyhow::anyhow!("Failed to create CBC decryptor: {}", e))?;

        let mut decrypted = encrypted_key.to_vec();
        let decrypted_key = decryptor
            .decrypt_padded_mut::<aes::cipher::block_padding::Pkcs7>(&mut decrypted)
            .map_err(|e| anyhow::anyhow!("CBC decryption failed: {}", e))?;

        if decrypted_key.len() < 24 {
            anyhow::bail!(
                "Decrypted key too short: need at least 24 bytes (16 key + 8 nonce), got {}",
                decrypted_key.len()
            );
        }

        let key = decrypted_key[..16].to_vec();
        let nonce = decrypted_key[16..24].to_vec();

        debug!(
            "Extracted AES-128 key ({} bytes) and nonce ({} bytes)",
            key.len(),
            nonce.len()
        );

        Ok(DecryptedKey { key, nonce })
    }

    pub fn new(encryption_key_b64: &str) -> anyhow::Result<Self> {
        if encryption_key_b64.is_empty() {
            anyhow::bail!("Empty encryption key");
        }

        debug!("Decrypting TIDAL key ID");
        let decrypted = Self::decrypt_key_id(encryption_key_b64)?;

        Ok(Self {
            key: decrypted.key,
            nonce: decrypted.nonce,
        })
    }

    fn build_iv_for_offset(&self, byte_offset: u64) -> [u8; 16] {
        let mut iv = [0u8; 16];
        iv[..8].copy_from_slice(&self.nonce);

        let block_number = byte_offset / 16;

        iv[8..16].copy_from_slice(&block_number.to_be_bytes());

        iv
    }

    pub fn decrypt_chunk(
        &self,
        encrypted_data: &[u8],
        byte_offset: u64,
    ) -> anyhow::Result<Vec<u8>> {
        if encrypted_data.is_empty() {
            return Ok(Vec::new());
        }

        debug!(
            "Decrypting {} bytes at offset {} with AES-128-CTR",
            encrypted_data.len(),
            byte_offset
        );

        let iv = self.build_iv_for_offset(byte_offset);

        type Aes128Ctr = Ctr128BE<Aes128>;
        let mut cipher = Aes128Ctr::new_from_slices(&self.key, &iv)
            .map_err(|e| anyhow::anyhow!("Failed to create CTR cipher: {}", e))?;

        let block_offset = (byte_offset % 16) as usize;
        let mut decrypted = encrypted_data.to_vec();

        if block_offset > 0 {
            let mut temp = vec![0u8; block_offset + decrypted.len()];
            temp[block_offset..].copy_from_slice(&decrypted);
            cipher.apply_keystream(&mut temp);
            decrypted.copy_from_slice(&temp[block_offset..]);
        } else {
            cipher.apply_keystream(&mut decrypted);
        }

        Ok(decrypted)
    }
}
