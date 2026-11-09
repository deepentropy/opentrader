/*
 * Process memory of answers, bounded. Every entry carries a stamp (the day it
 * was resolved for, or when it was fetched) that the caller checks on read;
 * past `capacity` entries the oldest is dropped, so a long session that opens
 * many symbols keeps a fixed amount of memory.
 *
 * The lock is held for the map operation only, never across a fetch.
 */
use crate::sync::LockExt;
use std::borrow::Borrow;
use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Mutex;

pub struct Memo<K, S, V> {
    capacity: usize,
    map: Mutex<Option<Entries<K, S, V>>>,
}

struct Entries<K, S, V> {
    items: HashMap<K, Entry<S, V>>,
    /// Insertion counter: the smallest is the oldest entry.
    next: u64,
}

struct Entry<S, V> {
    seq: u64,
    stamp: S,
    value: V,
}

impl<K: Hash + Eq + Clone, S, V: Clone> Memo<K, S, V> {
    pub const fn new(capacity: usize) -> Self {
        Self { capacity, map: Mutex::new(None) }
    }

    /// The value of `key` when `fresh` accepts its stamp.
    pub fn get<Q>(&self, key: &Q, fresh: impl FnOnce(&S) -> bool) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let map = self.map.locked();
        let e = map.as_ref()?.items.get(key)?;
        fresh(&e.stamp).then(|| e.value.clone())
    }

    /// Keep `value` under `key`, dropping the oldest entry when full.
    pub fn insert(&self, key: K, stamp: S, value: V) {
        let mut map = self.map.locked();
        let m = map.get_or_insert_with(|| Entries { items: HashMap::new(), next: 0 });
        if !m.items.contains_key(&key) && m.items.len() >= self.capacity.max(1) {
            // A scan, but only when full, and inserts follow a network fetch.
            if let Some(oldest) = m.items.iter().min_by_key(|(_, e)| e.seq).map(|(k, _)| k.clone()) {
                m.items.remove(&oldest);
            }
        }
        let seq = m.next;
        m.next += 1;
        m.items.insert(key, Entry { seq, stamp, value });
    }

    pub fn clear(&self) {
        *self.map.locked() = None;
    }

    pub fn len(&self) -> usize {
        self.map.locked().as_ref().map_or(0, |m| m.items.len())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_oldest_entry_goes_first_when_full() {
        let m: Memo<String, u32, u32> = Memo::new(2);
        m.insert("a".into(), 1, 10);
        m.insert("b".into(), 1, 20);
        m.insert("a".into(), 2, 11); // replaced: still two entries, and "a" is now the newest
        m.insert("c".into(), 1, 30);
        assert_eq!(m.len(), 2);
        assert_eq!(m.get("b", |_| true), None);
        assert_eq!(m.get("a", |s| *s == 2), Some(11));
        assert_eq!(m.get("c", |_| true), Some(30));
    }

    #[test]
    fn a_stale_stamp_reads_as_missing() {
        let m: Memo<&str, u32, &str> = Memo::new(4);
        m.insert("k", 1, "v");
        assert_eq!(m.get("k", |day| *day == 2), None);
        assert_eq!(m.get("k", |day| *day == 1), Some("v"));
        m.clear();
        assert!(m.is_empty());
    }
}
