import { google } from 'googleapis';
import { getAuthenticatedClient } from './googleClient.js';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

// Orari di lavoro
const WORKING_HOURS = {
    start: 8,
    end: 17,
    lunchStart: 12.5,  // 12:30 (12 + 30/60 = 12.5)
    lunchEnd: 13.5,    // 13:30 (13 + 30/60 = 13.5)
};

const SLOT_DURATION_MINUTES = 120; // 2 ore

// Slot fissi: 8:30, 10:30, 13:30, 15:30
const FIXED_SLOT_HOURS = [
    { hour: 8, minute: 30 },
    { hour: 10, minute: 30 },
    { hour: 13, minute: 30 },
    { hour: 15, minute: 30 }
];

/**
 * Verifica se un orario è lavorativo
 */
function isWorkingHours(date) {
    const hour = date.getHours() + date.getMinutes() / 60; // Converti a decimale (es. 12:30 = 12.5)
    const day = date.getDay();
    
    console.log(`    🔍 isWorkingHours check: day=${day}, hour=${hour.toFixed(2)}`);
    
    if (day === 0 || day === 6) {
        console.log(`    ❌ Weekend: day=${day}`);
        return false;
    }
    if (hour < WORKING_HOURS.start || hour >= WORKING_HOURS.end) {
        console.log(`    ❌ Fuori orario: ${hour.toFixed(2)} < ${WORKING_HOURS.start} || ${hour.toFixed(2)} >= ${WORKING_HOURS.end}`);
        return false;
    }
    if (hour >= WORKING_HOURS.lunchStart && hour < WORKING_HOURS.lunchEnd) {
        console.log(`    ❌ Pausa pranzo: ${hour.toFixed(2)} >= ${WORKING_HOURS.lunchStart} && ${hour.toFixed(2)} < ${WORKING_HOURS.lunchEnd}`);
        return false;
    }
    
    console.log(`    ✅ Orario lavorativo OK`);
    return true;
}

/**
 * Verifica se una data cade nel weekend
 */
function isWeekend(date) {
    const day = date.getDay();
    return day === 0 || day === 6;
}

/**
 * Ottiene slot disponibili in un range di date
 */
export async function getAvailableSlots(startDate, endDate) {
    try {
        console.log('📅 DEBUG getAvailableSlots - startDate:', startDate.toISOString(), '(locale:', startDate.toLocaleString('it-IT'), ')');
        console.log('📅 DEBUG getAvailableSlots - endDate:', endDate.toISOString(), '(locale:', endDate.toLocaleString('it-IT'), ')');
        
        const auth = await getAuthenticatedClient();
        const calendar = google.calendar({ version: 'v3', auth });
        
        const response = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin: startDate.toISOString(),
            timeMax: endDate.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });
        
        const events = response.data.items || [];
        console.log('📅 DEBUG - Eventi trovati nel calendario:', events.length);
        events.forEach(e => console.log('  -', e.summary, ':', e.start.dateTime || e.start.date));
        
        const availableSlots = [];
        
        // Normalizza le date per il confronto (solo data, senza ore)
        const startDay = new Date(startDate);
        startDay.setHours(0, 0, 0, 0);
        const endDay = new Date(endDate);
        endDay.setHours(23, 59, 59, 999);
        
        console.log('📅 DEBUG - Range normalizzato:', startDay.toLocaleDateString('it-IT'), '-', endDay.toLocaleDateString('it-IT'));
        
        // Itera giorno per giorno
        let currentDay = new Date(startDay);
        
        while (currentDay <= endDay) {
            console.log('📅 DEBUG - Controllando giorno:', currentDay.toLocaleDateString('it-IT'), 'day:', currentDay.getDay());
            
            // Per ogni giorno, controlla gli slot fissi
            for (const slot of FIXED_SLOT_HOURS) {
                // Crea lo slot in ora locale italiana
                const slotStart = new Date(currentDay);
                slotStart.setHours(slot.hour, slot.minute, 0, 0);
                const slotEnd = new Date(slotStart.getTime() + SLOT_DURATION_MINUTES * 60000);
                
                console.log('  🕐 DEBUG - Testando slot:', slotStart.toLocaleString('it-IT'), '(ora:', slot.hour + ':' + slot.minute, ')');
                console.log('    📍 Slot locale:', slotStart.toISOString(), '-', slotEnd.toISOString());
                
                // Verifica se è orario lavorativo
                if (!isWorkingHours(slotStart)) {
                    continue;
                }
                
                // Verifica se lo slot è libero
                const isSlotFree = !events.some(event => {
                    // Gli eventi arrivano da Google Calendar in UTC
                    const eventStartUTC = new Date(event.start.dateTime || event.start.date);
                    const eventEndUTC = new Date(event.end.dateTime || event.end.date);
                    
                    // FORZA conversione a Europe/Rome aggiungendo 1 ora (inverno) o 2 ore (estate)
                    // Determina se siamo in ora legale
                    const month = eventStartUTC.getMonth() + 1; // 1-12
                    const isDST = month >= 3 && month <= 10; // Marzo-Ottobre (approssimazione)
                    const offset = isDST ? 2 : 1; // +2 in estate, +1 in inverno
                    
                    // Converti eventi da UTC a ora italiana
                    const eventStart = new Date(eventStartUTC.getTime() + (offset * 60 * 60 * 1000));
                    const eventEnd = new Date(eventEndUTC.getTime() + (offset * 60 * 60 * 1000));
                    
                    const overlaps = (slotStart < eventEnd && slotEnd > eventStart);
                    
                    console.log('    🔎 Controllo evento:', event.summary);
                    console.log('      Event UTC:', eventStartUTC.toISOString(), '-', eventEndUTC.toISOString());
                    console.log('      Offset applicato:', offset, 'ore (DST:', isDST, ')');
                    console.log('      Event locale:', eventStart.toISOString(), '-', eventEnd.toISOString());
                    console.log('      Slot locale:', slotStart.toISOString(), '-', slotEnd.toISOString());
                    console.log('      Overlap?', slotStart, '<', eventEnd, '&&', slotEnd, '>', eventStart, '=', overlaps);
                    
                    if (overlaps) {
                        console.log('    ⚠️ OVERLAP TROVATO con:', event.summary);
                    } else {
                        console.log('    ✅ NO overlap con:', event.summary);
                    }
                    
                    return overlaps;
                });
                
                if (isSlotFree) {
                    console.log('    ✅✅✅ SLOT LIBERO CONFERMATO ✅✅✅');
                    availableSlots.push({
                        start: new Date(slotStart),
                        end: new Date(slotEnd),
                        date: slotStart.toLocaleDateString('it-IT'),
                        time: slotStart.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
                    });
                } else {
                    console.log('    ❌ SLOT OCCUPATO');
                }
            }
            
            // Passa al giorno successivo
            currentDay.setDate(currentDay.getDate() + 1);
            console.log('📅 DEBUG - Passaggio a giorno successivo:', currentDay.toLocaleDateString('it-IT'));
        }
        
        console.log('📅 DEBUG - Slot disponibili totali trovati:', availableSlots.length);
        availableSlots.forEach(s => console.log('  ✅', s.date, s.time));
        
        return availableSlots;
    } catch (error) {
        console.error('❌ Errore Calendar API:', error);
        throw error;
    }
}

/**
 * Trova il primo slot disponibile
 */
export async function findFirstAvailableSlot() {
    const now = new Date();
    const twoWeeksLater = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    
    const slots = await getAvailableSlots(now, twoWeeksLater);
    return slots.length > 0 ? slots[0] : null;
}

/**
 * Trova slot in una settimana specifica
 */
export async function findSlotsInWeek(weekOffset = 0) {
    const now = new Date();
    
    // Calcola il lunedì della settimana corrente o futura
    const currentDay = now.getDay(); // 0 = domenica, 1 = lunedì, ..., 6 = sabato
    const daysToMonday = currentDay === 0 ? -6 : 1 - currentDay; // Se domenica → -6, altrimenti → giorni al lunedì
    
    // Lunedì della settimana corrente (o futura se weekOffset > 0)
    const monday = new Date(now);
    monday.setDate(now.getDate() + daysToMonday + (weekOffset * 7));
    monday.setHours(0, 0, 0, 0);
    
    // Venerdì della stessa settimana
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4); // Lunedì + 4 giorni = Venerdì
    friday.setHours(23, 59, 59, 999);
    
    console.log('📅 DEBUG findSlotsInWeek - weekOffset:', weekOffset);
    console.log('📅 DEBUG - Oggi:', now.toLocaleDateString('it-IT'), 'day:', currentDay);
    console.log('📅 DEBUG - Lunedì:', monday.toLocaleDateString('it-IT'));
    console.log('📅 DEBUG - Venerdì:', friday.toLocaleDateString('it-IT'));
    
    const slots = await getAvailableSlots(monday, friday);
    
    return {
        week: `${monday.toLocaleDateString('it-IT')} - ${friday.toLocaleDateString('it-IT')}`,
        slots: slots,
        morning: slots.filter(s => s.start.getHours() < WORKING_HOURS.lunchStart),
        afternoon: slots.filter(s => s.start.getHours() >= WORKING_HOURS.lunchEnd),
    };
}

/**
 * Trova primo giorno con slot disponibili
 */
export async function findFirstDayWithSlot(period = 'any', weekOffset = 0) {
    const weekData = await findSlotsInWeek(weekOffset);
    
    let slotsToCheck = weekData.slots;
    if (period === 'morning') slotsToCheck = weekData.morning;
    else if (period === 'afternoon') slotsToCheck = weekData.afternoon;
    
    if (slotsToCheck.length === 0) return null;
    
    const slotsByDay = {};
    slotsToCheck.forEach(slot => {
        if (!slotsByDay[slot.date]) slotsByDay[slot.date] = [];
        slotsByDay[slot.date].push(slot);
    });
    
    const firstDay = Object.keys(slotsByDay)[0];
    return {
        date: firstDay,
        slots: slotsByDay[firstDay],
    };
}

/**
 * Crea appuntamento
 */
export async function createAppointment(startDateTime, customerName, customerPhone, address) {
    try {
        const auth = await getAuthenticatedClient();
        const calendar = google.calendar({ version: 'v3', auth });
        
        const endDateTime = new Date(startDateTime.getTime() + SLOT_DURATION_MINUTES * 60000);
        
        // Formatta date in formato ISO senza conversione UTC
        // Google Calendar interpreterà l'orario secondo il timeZone specificato
        const formatDateTimeForCalendar = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            const seconds = String(date.getSeconds()).padStart(2, '0');
            return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
        };
        
        const event = {
            summary: `Intervento - ${customerName}`,
            description: `Cliente: ${customerName}\nTelefono: ${customerPhone}\nIndirizzo: ${address}`,
            start: {
                dateTime: formatDateTimeForCalendar(startDateTime),
                timeZone: 'Europe/Rome',
            },
            end: {
                dateTime: formatDateTimeForCalendar(endDateTime),
                timeZone: 'Europe/Rome',
            },
            reminders: {
                useDefault: false,
                overrides: [
                    { method: 'email', minutes: 24 * 60 },
                    { method: 'popup', minutes: 60 },
                ],
            },
        };
        
        const response = await calendar.events.insert({
            calendarId: CALENDAR_ID,
            resource: event,
        });
        
        return {
            success: true,
            eventId: response.data.id,
            htmlLink: response.data.htmlLink,
            slot: {
                date: startDateTime.toLocaleDateString('it-IT'),
                time: startDateTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
            },
        };
    } catch (error) {
        console.error('❌ Errore creazione evento:', error);
        throw error;
    }
}

/**
 * Analizza richiesta in linguaggio naturale - MIGLIORATA
 */
export async function parseSchedulingRequest(userRequest) {
    const request = userRequest.toLowerCase();
    const now = new Date();
    
    // "primo slot disponibile"
    if (request.includes('primo') && (request.includes('disponibile') || request.includes('libero'))) {
        const slot = await findFirstAvailableSlot();
        if (!slot) {
            return { 
                type: 'no_slots', 
                message: 'Non ci sono slot disponibili nelle prossime 2 settimane.' 
            };
        }
        return { 
            type: 'first_available', 
            slot: slot,
            message: `Il primo slot disponibile è ${slot.date} alle ore ${slot.time}`,
        };
    }
    
    let weekOffset = 0;
    let specificDate = null;
    
    if (request.includes('oggi')) {
        specificDate = new Date(now);
        specificDate.setHours(0, 0, 0, 0);
    } else if (request.includes('domani')) {
        specificDate = new Date(now);
        specificDate.setDate(now.getDate() + 1);
        specificDate.setHours(0, 0, 0, 0);
    } else if (request.includes('prossima settimana') || request.includes('settimana prossima')) {
        weekOffset = 1;
    }
    
    let period = 'any';
    if (request.includes('pomeriggio')) period = 'afternoon';
    else if (request.includes('mattina') || request.includes('mattino')) period = 'morning';
    
    // Controlla se la data richiesta cade nel weekend
    if (specificDate && isWeekend(specificDate)) {
        const dayName = request.includes('oggi') ? 'oggi' : 'domani';
        return {
            type: 'weekend',
            message: `Mi dispiace, ma ${dayName} cade nel weekend e i nostri tecnici non lavorano. Possiamo fissare un appuntamento per lunedì?`,
        };
    }
    
    // Se è una data specifica (oggi/domani), cerca solo in quel giorno
    if (specificDate) {
        const endOfDay = new Date(specificDate);
        endOfDay.setHours(23, 59, 59, 999);
        
        const slots = await getAvailableSlots(specificDate, endOfDay);
        
        // DEBUG: Log per capire cosa sta succedendo
        console.log('🔍 DEBUG - Data richiesta:', specificDate.toLocaleDateString('it-IT'));
        console.log('🔍 DEBUG - Tutti gli slot trovati:', slots.map(s => `${s.time} (ora: ${s.start.getHours()})`));
        console.log('🔍 DEBUG - Period richiesto:', period);
        console.log('🔍 DEBUG - WORKING_HOURS.lunchEnd:', WORKING_HOURS.lunchEnd);
        
        let filteredSlots = slots;
        if (period === 'morning') filteredSlots = slots.filter(s => s.start.getHours() < WORKING_HOURS.lunchStart);
        else if (period === 'afternoon') filteredSlots = slots.filter(s => s.start.getHours() >= WORKING_HOURS.lunchEnd);
        
        console.log('🔍 DEBUG - Slot dopo filtro:', filteredSlots.map(s => s.time));
        
        if (filteredSlots.length === 0) {
            const dayName = request.includes('oggi') ? 'oggi' : 'domani';
            const periodName = period === 'morning' ? 'la mattina' : period === 'afternoon' ? 'il pomeriggio' : '';
            return {
                type: 'no_slots',
                message: `Non ci sono slot disponibili ${dayName} ${periodName}.`,
            };
        }
        
        return {
            type: 'slots_found',
            date: filteredSlots[0].date,
            slots: filteredSlots,
            message: `${request.includes('oggi') ? 'Oggi' : 'Domani'} ${period === 'afternoon' ? 'pomeriggio' : period === 'morning' ? 'mattina' : ''} ci sono questi slot: ${filteredSlots.map(s => s.time).join(', ')}`,
        };
    }
    
    // Altrimenti cerca nella settimana
    const dayData = await findFirstDayWithSlot(period, weekOffset);
    
    if (!dayData) {
        return { 
            type: 'no_slots', 
            message: `Non ci sono slot ${period === 'morning' ? 'la mattina' : period === 'afternoon' ? 'il pomeriggio' : ''} ${weekOffset === 1 ? 'la prossima settimana' : 'questa settimana'}.`,
        };
    }
    
    return {
        type: 'slots_found',
        date: dayData.date,
        slots: dayData.slots,
        message: `${weekOffset === 1 ? 'La prossima settimana' : 'Questa settimana'}, il primo giorno ${period === 'morning' ? 'con slot la mattina' : period === 'afternoon' ? 'con slot il pomeriggio' : 'disponibile'} è ${dayData.date}. Slot: ${dayData.slots.map(s => s.time).join(', ')}`,
    };
}
