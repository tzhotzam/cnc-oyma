# 3 Eksen Rölyef Oyma

Üç eksenli CNC router için **rölyef** tasarlar, takım telafisini hesaplar ve
doğrudan tezgâha giden **G-code** çıkarır. Rölyefi ya hazır parametrik desen
ailelerinden üretirsin ya da elindeki **STL modelini** yükleyip oyarsın.

Tamamı tarayıcıda çalışır: sunucu yok, kurulum yok, hiçbir veri cihazından
çıkmaz. Telefonda da açılır, ana ekrana eklenince uygulama gibi durur.

> Programın ürettiği dosya bir öneridir, garanti değil. İlerleme ve devir
> değerlerini kendi tezgâhınıza göre siz ayarlarsınız; ilk çalıştırmadan önce
> mutlaka bir simülatörde açıp bakın.

---

## Nasıl çalışıyor

### 1. Kaynak: parametrik desen ya da STL

İki giriş var. **Parametrik desen** hazır ailelerden üretir (aşağıdaki faz
alanı). **STL modeli** ise elindeki 3B modeli yukarıdan ortografik olarak
tarar: her ızgara hücresinde en yüksek Z tutulur ("z-buffer"). Modelin altında
kalan ve arkaya bakan yüzeyler rölyefe giremez — üç eksenli tezgâh zaten oraya
ulaşamaz, o yüzden tarama tam olarak ucun görebildiğini verir.

STL ayarları:

- **Bakış ekseni** — modelin üstü hangi eksen (Z/Y/X). Çoğu model Z yukarıdır
  ama oyuncak/karakter modelleri sık sık Y yukarı gelir. Yanlış eksende model
  panelin küçük bir şeridine düşer; program bunu fark edip uyarır.
- **Model dışı kalan alan** — en derine insin (model öne çıkar) ya da
  dokunulmasın (üst yüzeyde kalsın).
- **Ölçekleme** — varsayılan "görünen yüzeye göre". Katı bir modelde kutu
  yüksekliğinin çoğu gövdedir; modelin tamamına göre ölçeklersek 20 mm'lik bir
  bloğun üstündeki 3 mm'lik kabartma aralığın ancak %15'ini kullanır ve rölyef
  sönük çıkar. Görünen aralık tam kontrast verir.
- **Yumuşatma** — tarama basamaklarını ve ağ gürültüsünü siler (mm cinsinden).
- **Ters çevir** — tümsek ↔ çukur. Kalıp çıkarmak için.
- **Panel oranını modelden al** — panel en-boy oranı modelin ayak izine uyar.

Derinlik, kubbe/çanak, kenar şeridi ve kademelendirme **her iki kaynakta da**
aynı şekilde çalışır; STL'den gelen harita da bu işlemlerden geçer.

### 2. Faz alanı

Desen bir φ(x,y) fonksiyonundan doğar. φ'nin tam sayı kısmı hangi bantta
olduğunuzu, ondalık kısmı bandın neresinde olduğunuzu söyler. Desenin karakteri
tamamen φ'nin biçiminden gelir.

| Aile | Ne veriyor |
|---|---|
| **Burgu** | Paralel bantlar merkeze doğru artan açıyla döner, kenarda düze yakın kalır — S kıvrımı buradan çıkar. |
| **Spiral** | Logaritmik (deniz kabuğu oranı) veya Arşimet spirali, istenen kol sayısıyla. |
| **Halka dalga** | Eş merkezli halkalar. |
| **Yelpaze** | Merkezden çıkan ışınlar. |
| **Kum tepeleri** | Dalgalanan paralel sırtlar. |
| **Balıksırtı** | V biçimli bantlar. |
| **Örgü** | Birbirini kesen iki bant ailesi, yastıklı kareler. |
| **Çiçek** | Yapraklı radyal desen. |

### 3. Kesit profili

Bandın ağız şekli: yarım daire sırt (etli), yumuşak dalga, yuvarlak dipli oluk,
V, testere, düz tepeli. **Asimetri** kaydırıcısı sırtın bir yanını dikleştirir;
**kademe sayısı** topografik basamaklar yapar.

### 4. Derinlik

Bant derinliği mm cinsindendir. Üstüne genel bir kubbe/çanak, merkez–kenar
derinlik farkı, kenarda düz şerit ve merkezde düz ada eklenebilir.

**Bütün Z değerleri 0 veya eksidir**: 0 = malzemenin dokunulmamış üst yüzeyi,
−12 = o noktada 12 mm aşağı inilmiş. Artı Z sadece havada gezerken kullanılır.

### 5. Takım telafisi (drop-cutter)

Bu adım programın can damarıdır. Yükseklik haritası *yüzeyin kendisidir*,
takımın gideceği yol değil. 6 mm'lik bilya uç, 2 mm'lik bir oluğun dibine zaten
giremez; oraya kadar indirirseniz kenarları yer. Program her nokta için takımı
yüzeye değene kadar indirir:

```
zt(x,y) = max over (dx,dy) [ z(x+dx, y+dy) − dz(√(dx²+dy²)) ]
```

`dz(r)`, takım ucundan r kadar yanda alt yüzeyin ne kadar yukarıda olduğudur —
bilyada `R−√(R²−r²)`, düz frezede `0`, V uçta `r/tan(θ/2)`. Matematiksel olarak
gri-seviye genleşme (dilation) ile aynı işlemdir.

Tersi de hesaplanır (aşındırma): **önizlemede gördüğünüz yüzey, idealin değil,
seçtiğiniz uçla gerçekten çıkacak olanın kendisidir.** Kesit sekmesinde ikisi
üst üste çizilir — kesikli çizgi ideal, dolu çizgi takımın bıraktığı.

### 6. Pasolar

- **Kaba** — Z seviyeli, finiş payı bırakır, dalarken rampa yapar.
- **Finiş** — telafi edilmiş yüzeyi birebir takip eder.
- **Kontur** — paneli levhadan köprülerle keser (isteğe bağlı).

### 7. G-code

GRBL/Candle, Mach3 veya Fanuc/NCStudio ağzından yazılır. Yorumlar ASCII'ye
indirilir (eski kontrolcüler Türkçe karakterde takılır), yollar 0,01 mm
toleransla sadeleştirilir, değişmeyen eksen harfleri tekrar yazılmaz.

Kısa bağlantılarda takım tepeye kadar çıkmaz — aradaki yüzeyin en yüksek
noktası örneklenip onun üstünden geçilir. Bu alçak geçişler bilerek **kesme
hızında (G1)** yazılır: kaba pasodan artakalan bir kabartmaya denk gelirse
normal bir talaş olur, çarpma olmaz. Böylece programdaki **her hızlı hareket
ham yüzeyin üstünde kalır** — testler bunu doğruluyor.

---

## Düz freze mi, bilya uç mu?

Varsayılan finiş ucu **6 mm düz freze**dir, çünkü elde en çok o bulunur. Ama
düz freze eğri yüzeyi ucuyla değil **kenarıyla** keser: yamaçta altındaki en
yüksek noktaya oturur ve orayı düzleştirir. Bunun iki ayrı sonucu var ve
karıştırmamak gerekir:

**1. Pasolar arası iz.** Bilya uçta bu bir tırtıktır ve ucun yarıçapı belirler:
`R − √(R²−(a/2)²)`. Düz frezede tırtık değil kademe kalır ve boyunu ucun çapı
değil **desenin eğimi** belirler:

```
kademe ≈ yanal adım × tan(eğim)
```

Yani 12 mm'lik bir uç da 6 mm'lik de aynı izi bırakır; fark deseni ne kadar dik
yaptığındadır.

**2. Ucun giremediği yerler.** Bundan daha önemlisi budur. Sivri dipli bir
vadiye 6 mm'lik bir uç fiziken giremez. Aynı burgu deseninin iki kesitle
ölçülmüş hâli (6 mm düz freze, 600 mm daire):

| Kesit | İdeal derinlik | Ulaşılan | Ortalama sapma | En kötü |
|---|---|---|---|---|
| Yarım daire sırt | −11,5 mm | **−8,4 mm** | 0,078 mm | 4,53 mm |
| **Yumuşak dalga** | −12,0 mm | **−11,9 mm** | **0,006 mm** | 0,62 mm |
| Düz tepeli (plato) | −11,9 mm | −10,7 mm | 0,051 mm | 2,47 mm |
| Testere | −12,0 mm | −11,4 mm | 0,024 mm | 10,53 mm |

Sonuç net: **düz frezen varsa kesiti "Yumuşak dalga" seç.** Aynı derinliğe
inilir, sapma yirmide bire düşer. "🔩 Düz frezeye göre" hazır deseni tam olarak
bunu kurar. Bant sayısını da abartma — bant daraldıkça uç aralarına giremez.

Program bunu tahmin etmez, **ölçer**: özet çubuğundaki "Kalan malzeme",
işlenmiş yüzeyle ideal arasındaki en büyük farktır ve önizlemede gördüğün yüzey
zaten seçtiğin uçla gerçekten çıkacak olandır.

Bilya uç alırsan (6 mm, birkaç yüz lira) her kesit açılır: yarım daire sırtta
bile sapma 3,8 mm'den çok daha aşağı iner ve yanal adımı 0,85 mm'ye açıp aynı
kalitede 6 kat hızlı bitirirsin.

---

## Finiş stratejileri

| Strateji | Ne zaman |
|---|---|
| **Satır tarama** | Her işte çalışır, en öngörülebiliri. |
| **Desen boyunca** | Yollar deseni takip eder — freze izi olukla aynı yöne düşer, zımparadan önce bile temiz görünür. Fazın gradyanına dik akış çizgileri izlenerek üretilir. STL kaynağında aynı strateji **eş-yükselti** çizgilerine döner: yollar modelin kendi hatlarını takip eder. Eğimin kaybolduğu düz alanlarda raster açısına düşer, böylece hiçbir yer finişsiz kalmaz. |
| **Spiral** | Yuvarlak panelde tek parça yol, yön değiştirmez. |
| **Işınsal** | Merkezden kenara ışınlar; yelpaze/çiçek desenleriyle örtüşür. |

**Tırtık (scallop)**: iki paso arasında kalan sırt yüksekliği
`R − √(R²−(a/2)²)`. "Tırtığa göre adım hesapla" düğmesi hedef tırtık için
gereken yanal adımı verir. 0,03 mm tipik bir finiş değeridir; 6 mm bilya uçta
~0,85 mm adım demektir.

---

## Çıktılar

- **`.nc` G-code** — asıl iş.
- **PNG yükseklik haritası** — Aspire / ArtCAM / Carveco'ya "bitmap to relief"
  diye girer (255 = üst yüzey, 0 = en derin nokta).
- **STL** — başka bir CAM'de veya simülatörde doğrulamak için.
- **CSV derinlik tablosu** — 10 mm ızgarada Z değerleri, hepsi eksi.
- **JSON ayar dosyası** — tasarımı saklayıp geri yüklemek için.

---

## Makinede nasıl işlenir

1. **Sıfır** — X0Y0 seçtiğiniz yerde (varsayılan: panelin merkezi), **Z0
   malzemenin ÜST yüzeyinde**.
2. **Bağlama** — iki taraflı bant + vida ya da vakum. Kontur kesiyorsanız
   köprüleri bırakın, yoksa parça son turda fırlar.
3. **Prova** — Z sıfırını 50 mm yukarıda alıp programı havada çalıştırın.
4. **Takım değişimi** — kaba ve finiş uçları farklıysa program orada durur (M0).
   Yeni ucu taktıktan sonra **Z sıfırını tekrar alın**.
5. **Sıra** — kaba → finiş → (varsa) kontur. Finişte tozu üfleyin.

---

## Yerelde çalıştırmak

ES modülleri `file://` üzerinden çalışmaz, küçük bir sunucu gerekir:

```bash
python3 -m http.server 8000
# tarayıcıda: http://localhost:8000
```

## Testler

```bash
node tests/oyma.test.mjs
```

Desen alanı ve profiller, takım geometrisi, takım telafisinin gouge yapmadığı,
kaba/finiş/kontur pasolarının sınırları, hızlı hareketlerin malzemeye girmediği,
G-code'un yapısı (eksi Z, ASCII, kontrolcü ağızları) ve dışa aktarma biçimleri
doğrulanır. Tarayıcı gerekmez.

---

## Mimari

```
index.html      arayüz
app.css         stiller (mobil öncelikli, karanlık tema)
js/
  main.js       akış: desen → yüzey → telafi → yollar → G-code
  pattern.js    faz alanı, kesit profilleri, mm cinsinden Z haritası
  stl.js        STL okuma + tepeden z-buffer taraması
  tool.js       uç geometrisi, drop-cutter telafisi, tırtık hesabı
  toolpath.js   kaba/finiş/kontur pasoları, akış çizgileri, sadeleştirme
  gcode.js      GRBL / Mach3 / Fanuc post-processor
  export.js     STL, gri ton yükseklik haritası, derinlik tablosu
  preview.js    rölyef gölgelemesi, takım yolu, kesit (canvas)
  view3d.js     three.js ile 3B önizleme
tests/          tarayıcısız doğrulama
```

Üretim modülleri tarayıcıya bağımlı değildir; Node'dan doğrudan çağrılabilir.
