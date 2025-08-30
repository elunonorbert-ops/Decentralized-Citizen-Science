;; SpeciesLedger.clar
;; Core contract for maintaining immutable records of verified species observations.
;; This contract serves as the decentralized ledger for citizen science data on species tracking.
;; It stores verified observations, provides aggregation functions for trends, and supports queries.
;; Data can only be added by authorized validators (e.g., from ValidationEngine.clar).
;; Features include: immutable storage, aggregation of population trends, migration patterns,
;; query functions for researchers, and event emissions for off-chain indexing.

;; Constants
(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-INVALID-OBSERVATION u101)
(define-constant ERR-ALREADY-EXISTS u102)
(define-constant ERR-INVALID-QUERY-PARAMS u103)
(define-constant ERR-NOT-FOUND u104)
(define-constant MAX-EVIDENCE-LEN u1024)
(define-constant MAX-SPECIES-NAME-LEN u50)
(define-constant MAX-LOCATION-DESC-LEN u100)
(define-constant AUTHORIZED-VALIDATOR 'SP000000000000000000002Q6VF78) ;; Placeholder for ValidationEngine principal

;; Data Structures
(define-map observations
  { observation-id: uint }
  {
    species: (string-utf8 50),
    timestamp: uint,
    location-lat: int,    ;; Latitude multiplied by 1e6 for precision
    location-lon: int,    ;; Longitude multiplied by 1e6 for precision
    location-desc: (string-utf8 100),  ;; Human-readable location
    evidence-hash: (buff 32),          ;; Hash of photo/evidence (e.g., IPFS CID hash)
    contributor: principal,
    validator: principal,
    metadata: (string-utf8 500),       ;; Additional notes
    confidence-score: uint             ;; Validation score (0-100)
  }
)

(define-map observation-index-by-species
  { species: (string-utf8 50), timestamp: uint }
  { observation-id: uint }
)

(define-map observation-index-by-location
  { location-hash: (buff 32) }  ;; Hash of lat/lon for grouping
  { observation-ids: (list 1000 uint) }
)

(define-map aggregates-by-species
  { species: (string-utf8 50) }
  {
    total-observations: uint,
    last-observed: uint,
    avg-confidence: uint,
    population-trend: int  ;; Positive for increasing, negative for decreasing (computed delta)
  }
)

(define-map aggregates-by-region
  { region-hash: (buff 32) }  ;; Coarser location hash (e.g., country or grid)
  {
    species-count: uint,
    total-observations: uint,
    biodiversity-index: uint  ;; Simple metric, e.g., species diversity score
  }
)

(define-data-var next-observation-id uint u1)
(define-data-var total-observations uint u0)
(define-data-var admin principal tx-sender)
(define-data-var paused bool false)

;; Events (for off-chain indexing, Clarity 2.0+ style)
(define-trait event-trait
  (
    (emit-observation-added (uint (string-utf8 50) principal) (response bool uint))
  )
)

;; Private Functions
(define-private (hash-location (lat int) (lon int))
  (keccak256 (concat (i32-to-utf8 lat) (i32-to-utf8 lon)))  ;; Simplified hash, use proper in prod
)

(define-private (update-species-aggregate (species (string-utf8 50)) (timestamp uint) (confidence uint))
  (let
    (
      (current-agg (default-to { total-observations: u0, last-observed: u0, avg-confidence: u0, population-trend: 0 } (map-get? aggregates-by-species { species: species })))
      (new-total (+ (get total-observations current-agg) u1))
      (new-avg (/ (+ (* (get avg-confidence current-agg) (- new-total u1)) confidence) new-total))
      (new-trend (if (> timestamp (get last-observed current-agg)) 1 -1))  ;; Simplified trend
    )
    (map-set aggregates-by-species
      { species: species }
      {
        total-observations: new-total,
        last-observed: timestamp,
        avg-confidence: new-avg,
        population-trend: new-trend
      }
    )
  )
)

(define-private (update-region-aggregate (region-hash (buff 32)) (species (string-utf8 50)))
  (let
    (
      (current-agg (default-to { species-count: u0, total-observations: u0, biodiversity-index: u0 } (map-get? aggregates-by-region { region-hash: region-hash })))
      (new-obs (+ (get total-observations current-agg) u1))
      (new-species-count (get species-count current-agg))  ;; TODO: Increment if new species
      (new-index (+ (get biodiversity-index current-agg) u1))  ;; Placeholder
    )
    (map-set aggregates-by-region
      { region-hash: region-hash }
      {
        species-count: new-species-count,
        total-observations: new-obs,
        biodiversity-index: new-index
      }
    )
  )
)

;; Public Functions
(define-public (add-observation
  (species (string-utf8 50))
  (timestamp uint)
  (lat int)
  (lon int)
  (location-desc (string-utf8 100))
  (evidence-hash (buff 32))
  (metadata (string-utf8 500))
  (confidence-score uint)
  (contributor principal))
  (begin
    (asserts! (is-eq tx-sender AUTHORIZED-VALIDATOR) (err ERR-UNAUTHORIZED))
    (asserts! (not (var-get paused)) (err ERR-PAUSED))
    (asserts! (<= (len species) MAX-SPECIES-NAME-LEN) (err ERR-INVALID-OBSERVATION))
    (asserts! (<= (len location-desc) MAX-LOCATION-DESC-LEN) (err ERR-INVALID-OBSERVATION))
    (asserts! (<= (len metadata) MAX-EVIDENCE-LEN) (err ERR-INVALID-OBSERVATION))
    (asserts! (<= confidence-score u100) (err ERR-INVALID-OBSERVATION))
    (let
      (
        (obs-id (var-get next-observation-id))
        (loc-hash (hash-location lat lon))
        (region-hash (keccak256 location-desc))  ;; Coarse region hash
        (current-ids (default-to (list) (get observation-ids (map-get? observation-index-by-location { location-hash: loc-hash }))))
      )
      ;; Check for duplicates (simplified)
      (asserts! (is-none (map-get? observation-index-by-species { species: species, timestamp: timestamp })) (err ERR-ALREADY-EXISTS))
      ;; Store observation
      (map-set observations
        { observation-id: obs-id }
        {
          species: species,
          timestamp: timestamp,
          location-lat: lat,
          location-lon: lon,
          location-desc: location-desc,
          evidence-hash: evidence-hash,
          contributor: contributor,
          validator: tx-sender,
          metadata: metadata,
          confidence-score: confidence-score
        }
      )
      ;; Index by species and timestamp
      (map-set observation-index-by-species
        { species: species, timestamp: timestamp }
        { observation-id: obs-id }
      )
      ;; Index by location
      (map-set observation-index-by-location
        { location-hash: loc-hash }
        { observation-ids: (unwrap-panic (as-max-len? (append current-ids obs-id) u1000)) }
      )
      ;; Update aggregates
      (update-species-aggregate species timestamp confidence-score)
      (update-region-aggregate region-hash species)
      ;; Increment counters
      (var-set next-observation-id (+ obs-id u1))
      (var-set total-observations (+ (var-get total-observations) u1))
      ;; Emit event (placeholder, as Clarity doesn't have native events; use print for now)
      (print { event: "observation-added", id: obs-id, species: species, contributor: contributor })
      (ok obs-id)
    )
  )
)

(define-public (pause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-UNAUTHORIZED))
    (var-set paused true)
    (ok true)
  )
)

(define-public (unpause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-UNAUTHORIZED))
    (var-set paused false)
    (ok true)
  )
)

(define-public (set-admin (new-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-UNAUTHORIZED))
    (var-set admin new-admin)
    (ok true)
  )
)

(define-public (set-authorized-validator (new-validator principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-UNAUTHORIZED))
    (ok (as-contract (define-constant AUTHORIZED-VALIDATOR new-validator)))  ;; Note: Constants can't be changed; this is placeholder
  )
)

;; Read-Only Functions
(define-read-only (get-observation (obs-id uint))
  (map-get? observations { observation-id: obs-id })
)

(define-read-only (get-observations-by-species (species (string-utf8 50)) (start-time uint) (end-time uint))
  (filter some
    (map
      (lambda (ts) (map-get? observation-index-by-species { species: species, timestamp: ts }))
      (filter (lambda (t) (and (>= t start-time) (<= t end-time)))
        (map get timestamp (map-get? observations))))  ;; Simplified; in practice, need better indexing
  )
)

(define-read-only (get-species-aggregate (species (string-utf8 50)))
  (map-get? aggregates-by-species { species: species })
)

(define-read-only (get-region-aggregate (region-hash (buff 32)))
  (map-get? aggregates-by-region { region-hash: region-hash })
)

(define-read-only (get-total-observations)
  (var-get total-observations)
)

(define-read-only (is-paused)
  (var-get paused)
)

(define-read-only (get-admin)
  (var-get admin)
)

;; Additional robust features: Correction mechanism (append correction note without mutating)
(define-map corrections
  { observation-id: uint }
  { note: (string-utf8 500), corrector: principal, timestamp: uint }
)

(define-public (add-correction (obs-id uint) (note (string-utf8 500)))
  (let ((obs (map-get? observations { observation-id: obs-id })))
    (asserts! (is-some obs) (err ERR-NOT-FOUND))
    (asserts! (or (is-eq tx-sender (get validator (unwrap-panic obs))) (is-eq tx-sender (var-get admin))) (err ERR-UNAUTHORIZED))
    (map-set corrections
      { observation-id: obs-id }
      { note: note, corrector: tx-sender, timestamp: block-height }
    )
    (ok true)
  )
)

(define-read-only (get-correction (obs-id uint))
  (map-get? corrections { observation-id: obs-id })
)

;; Export data for off-chain use (paginated query)
(define-read-only (get-paginated-observations (start uint) (limit uint))
  (let ((end (+ start limit)))
    (filter some
      (map (lambda (id) (map-get? observations { observation-id: id }))
        (range start end)
      )
    )
  )
)