// DEVİR, İLERLEME, TALAŞ PAYI
//
// İlerleme keyfî bir sayı değil, takımın her ağzının bir turda ne kadar
// malzeme aldığıyla belirlenir:
//
//     ilerleme (mm/dk) = devir (dev/dk) × ağız sayısı × talaş payı (mm/diş)
//
// Talaş payı çok küçükse uç kesmez, sürter: ısınır, körelir, malzemeyi yakar.
// Çok büyükse ağız zorlanır ve kırılır. Aşağıdaki değerler karbür freze ve
// ahşap/levha için yaygın başlangıç aralıklarıdır — son ayar tezgâhın
// sertliğine, bağlantının sağlamlığına ve çıkan yongaya bakılarak yapılır.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 6 mm çap için mm/diş talaş payı aralıkları. */
export const MATERIALS = {
  mdf:      { name: 'MDF / sunta', min: 0.10, max: 0.20, rpm: [16000, 20000] },
  kontrplak:{ name: 'Kontrplak',   min: 0.10, max: 0.18, rpm: [16000, 20000] },
  yumusak:  { name: 'Masif yumuşak (çam, ıhlamur)', min: 0.13, max: 0.25, rpm: [15000, 20000] },
  sert:     { name: 'Masif sert (meşe, ceviz)', min: 0.10, max: 0.20, rpm: [14000, 18000] },
  plastik:  { name: 'Plastik (PVC, akrilik)', min: 0.08, max: 0.15, rpm: [12000, 16000] },
  kopuk:    { name: 'Köpük / strafor', min: 0.30, max: 0.60, rpm: [10000, 18000] },
  alcipan:  { name: 'Alçı / taş görünümlü döküm', min: 0.08, max: 0.15, rpm: [10000, 14000] },
};

/**
 * Talaş payı çapla büyür: kalın uç daha kalın yonga kaldırabilir.
 * 6 mm taban alınıp karekökle ölçeklenir — sektör tablolarına yakın sonuç verir.
 */
export function chipload(materialKey, dia) {
  const m = MATERIALS[materialKey] || MATERIALS.mdf;
  const k = Math.sqrt(clamp(dia, 1, 25) / 6);
  return { min: m.min * k, max: m.max * k, orta: ((m.min + m.max) / 2) * k };
}

/**
 * İlerleme önerisi.
 * @returns {{feed:number, feedMin:number, feedMax:number, plunge:number,
 *            chipload:number, stepdownMax:number, notlar:string[]}}
 */
export function suggestFeeds({ materialKey, dia, flutes, rpm, maxFeed = 6000 }) {
  const z = Math.max(1, Math.round(flutes || 2));
  const d = Math.max(0.5, dia || 6);
  const n = clamp(rpm || 18000, 1000, 40000);
  const c = chipload(materialKey, d);

  const feedMin = n * z * c.min;
  const feedMax = n * z * c.max;
  let feed = n * z * c.orta;
  const notlar = [];

  if (feed > maxFeed) {
    // Tezgâh bu ilerlemeye yetişemiyorsa devir düşürülmeli, yoksa uç sürter.
    const gereken = Math.round(maxFeed / (z * c.orta));
    notlar.push(
      `Bu devirde gereken ilerleme (${Math.round(feed)} mm/dk) tezgâhın sınırını ` +
      `aşıyor. Deviri ~${gereken} dev/dk'ya düşürün; aksi hâlde uç kesmeyip ` +
      `sürter, malzeme yanar ve ağız körelir.`
    );
    feed = maxFeed;
  }

  // Düz frezede tek pasoda inilecek derinlik: yan yükü makul tutan pratik sınır.
  const stepdownMax = d * 0.5;

  return {
    feed: Math.round(feed),
    feedMin: Math.round(feedMin),
    feedMax: Math.round(feedMax),
    plunge: Math.round(feed * 0.35),
    chipload: c.orta,
    stepdownMax,
    notlar,
  };
}

/**
 * Takım/iş uyuşmazlıkları. Sayısal ve somut: hangi ölçü neyi aşıyor.
 * @param {{dia,fluteLen,shankDia}} tool
 * @param {{depth,stepdown,thickness,cutout}} job
 */
export function toolChecks(tool, job) {
  const uyarilar = [];
  const derinlik = Math.abs(job.depth || 0);
  const kesmeBoyu = tool.fluteLen || 0;

  if (kesmeBoyu > 0 && derinlik > kesmeBoyu) {
    uyarilar.push(
      `Kesilecek derinlik ${derinlik.toFixed(1)} mm ama ucun kesme boyu ` +
      `${kesmeBoyu} mm. Bu derinliğe inerken sap malzemeye sürter: iz bırakır, ` +
      `ısınır, ucu sıkıştırıp kırabilir.`
    );
  }
  if (job.cutout && kesmeBoyu > 0 && (job.thickness || 0) + 1 > kesmeBoyu) {
    uyarilar.push(
      `Kontur kesimi ${(job.thickness || 0).toFixed(0)} mm kalınlığı baştan sona ` +
      `geçiyor ama kesme boyu ${kesmeBoyu} mm. Parçayı bu uçla levhadan ayıramazsınız.`
    );
  }
  if (job.stepdown > tool.dia * 0.5 + 1e-9) {
    uyarilar.push(
      `Paso derinliği (${job.stepdown} mm) takım çapının yarısını aşıyor ` +
      `(${(tool.dia * 0.5).toFixed(1)} mm). Yan yük artar, uç esner ve dalga bırakır.`
    );
  }
  if (tool.shankDia && tool.shankDia > 8) {
    uyarilar.push(
      `Sap çapı ${tool.shankDia} mm. Hobi tezgâhlarındaki ER11 pensler ` +
      `7 mm'ye kadar tutar; bu uç için ER16/ER20 pens ve uygun bir spindle gerekir.`
    );
  }
  return uyarilar;
}
