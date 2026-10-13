/**
 * The written authorization for van ride charges (Brief 1A-3).
 *
 *   An associate is charged for a ride only with this document signed, at
 *   the rate it names. The text is versioned: a change to the words bumps
 *   RIDE_AUTHORIZATION_VERSION and every rider signs again; a change to
 *   the rate (fare or no-show fee) does the same through the rate itself,
 *   because the signed document names the amounts.
 *
 *   English, Spanish and Turkish, in the associate's language. The
 *   rendered PDF (lib/esign.ts) is what gets stored and hashed.
 */

export const RIDE_AUTHORIZATION_VERSION = 1;

export type RideAuthLang = 'en' | 'es' | 'tr';

export interface RideAuthorizationTerms {
  fareCents: number;
  noShowFeeCents: number;
  orgName: string;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function rideAuthorizationTitle(lang: RideAuthLang): string {
  return {
    en: 'Authorization for van ride charges',
    es: 'Autorización de cargos por viajes en la van',
    tr: 'Servis ücreti kesintisi yetkilendirmesi',
  }[lang];
}

/** The body the associate signs. Plain text; the renderer lays it out. */
export function rideAuthorizationBody(lang: RideAuthLang, t: RideAuthorizationTerms): string {
  const fare = money(t.fareCents);
  const fee = money(t.noShowFeeCents);
  const en = `I ask ${t.orgName} to provide van rides between my home or pickup point and my work site, and I authorize the charges below to be deducted from my pay.

1. The charge for each ride I board is ${fare}. If I book a ride, the driver arrives at the pickup point, waits at least three minutes, and I do not board, the no-show fee is ${fee}. A ride I cancel before the driver arrives costs nothing. A ride cancelled by ${t.orgName} costs nothing.
2. Charges are deducted from the paycheck for the pay period in which the ride took place, or the next one. Each charge is listed on my pay statement with the number of rides and missed rides it covers.
3. No deduction will reduce my pay for any workweek below the applicable minimum wage. If a charge would, only the part that keeps my pay at or above the minimum wage is deducted in that period and the rest is carried to a later period, and my pay statement says so.
4. These are the only amounts this authorization covers. If the rate changes, no ride is charged at the new rate until I have signed a new authorization that names it.
5. I may withdraw this authorization at any time in the app or in writing. Rides already taken are still charged; no new ride is booked or charged after I withdraw.
6. Rides are voluntary. Whether I use the van has no effect on my employment, my schedule or my pay.

I have read this authorization in a language I understand. By typing my name below I sign it.`;

  const es = `Solicito a ${t.orgName} viajes en la van entre mi casa o punto de recogida y mi sitio de trabajo, y autorizo que los cargos siguientes se descuenten de mi pago.

1. El cargo por cada viaje que abordo es ${fare}. Si reservo un viaje, el conductor llega al punto de recogida, espera al menos tres minutos y no abordo, la tarifa por no presentarme es ${fee}. Un viaje que cancelo antes de que llegue el conductor no cuesta nada. Un viaje cancelado por ${t.orgName} no cuesta nada.
2. Los cargos se descuentan del cheque del período de pago en que ocurrió el viaje, o del siguiente. Cada cargo aparece en mi recibo de pago con el número de viajes y de viajes perdidos que cubre.
3. Ningún descuento reducirá mi pago por una semana de trabajo por debajo del salario mínimo aplicable. Si un cargo lo hiciera, solo se descuenta en ese período la parte que mantiene mi pago en el salario mínimo o por encima, el resto pasa a un período posterior, y mi recibo de pago lo indica.
4. Estos son los únicos montos que cubre esta autorización. Si la tarifa cambia, ningún viaje se cobra a la nueva tarifa hasta que yo firme una nueva autorización que la indique.
5. Puedo retirar esta autorización en cualquier momento en la app o por escrito. Los viajes ya realizados se cobran igual; no se reserva ni se cobra ningún viaje nuevo después de retirarla.
6. Los viajes son voluntarios. Usar o no la van no afecta mi empleo, mi horario ni mi pago.

He leído esta autorización en un idioma que entiendo. Al escribir mi nombre abajo, la firmo.`;

  const tr = `${t.orgName}'dan evim veya alınma noktam ile iş yerim arasında servis sağlamasını istiyorum ve aşağıdaki ücretlerin maaşımdan kesilmesine yetki veriyorum.

1. Bindiğim her servis için ücret ${fare}. Bir servis ayırtırsam, sürücü alınma noktasına gelir, en az üç dakika bekler ve ben binmezsem, gelmeme ücreti ${fee}. Sürücü gelmeden iptal ettiğim bir servis ücretsizdir. ${t.orgName} tarafından iptal edilen bir servis ücretsizdir.
2. Ücretler, servisin yapıldığı maaş döneminin çekinden veya bir sonrakinden kesilir. Her kesinti, kapsadığı servis ve gelmeme sayısıyla birlikte maaş dökümümde görünür.
3. Hiçbir kesinti herhangi bir çalışma haftası için maaşımı geçerli asgari ücretin altına düşürmez. Bir kesinti bunu yapacaksa, o dönemde yalnızca maaşımı asgari ücrette veya üzerinde tutan kısım kesilir, kalanı sonraki bir döneme aktarılır ve maaş dökümüm bunu belirtir.
4. Bu yetkilendirme yalnızca bu tutarları kapsar. Ücret değişirse, yeni ücreti belirten yeni bir yetkilendirme imzalayana kadar hiçbir servis yeni ücretten alınmaz.
5. Bu yetkilendirmeyi istediğim zaman uygulamada veya yazılı olarak geri çekebilirim. Zaten yapılmış servisler yine de ücretlendirilir; geri çektikten sonra yeni servis ayırtılmaz ve ücretlendirilmez.
6. Servisler gönüllüdür. Servisi kullanıp kullanmamam işimi, programımı veya maaşımı etkilemez.

Bu yetkilendirmeyi anladığım bir dilde okudum. Aşağıya adımı yazarak imzalıyorum.`;

  return { en, es, tr }[lang];
}

export function toRideAuthLang(language: string | null | undefined): RideAuthLang {
  const l = (language ?? 'en').toLowerCase();
  return l.startsWith('es') ? 'es' : l.startsWith('tr') ? 'tr' : 'en';
}
