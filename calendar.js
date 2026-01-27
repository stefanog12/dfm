import { google } from 'googleapis';
import { getAuthenticatedClient } from './googleClient.js';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

// Orari di lavoro
const WORKING_HOURS = {
    start: 8,
    end: 17,
    lunchStart: 12,
    lunchEnd: 13,
};

const SLOT_DURATION_MINUTES = 120; // 2 ore

// Slot fissi: 8:00, 10:00, 13:00, 15:00
const FIXED_SLOT_HOURS = [8, 10, 13, 15];

/**
 * Verifica se un orario è lavorativo
 */
function isWorkingHours(date) {
    const hour = date.getHours();
    const day = date.getDay();
    
    if (day === 0 || day === 6) return false;
    if (hour < WORKING_HOURS.start || hour >= WORKING_HOURS.end) return false;
    if (hour >= WORKING_HOURS.lunchStart && hour < WORKING_HOURS.lunchEnd) return false;
    
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
        const availableSlots = [];
        
        let currentDate = new Date(startDate);
        
        // Itera giorno per giorno
        while (currentDate < endDate) {
            const day = new Date(currentDate);
            day.setHours(0, 0, 0, 0);
            
            // Per ogni giorno, controlla gli slot fissi
            for (const hour of FIXED_SLOT_HOURS) {
                const slotStart = new Date(day);
                slotStart.setHours(hour, 0, 0, 0);
                
                // Salta slot nel passato
                if (slotStart < startDate) continue;
                if (slotStart >= endDate) break;
                
                // Verifica se è orario lavorativo
                if (!isWorkingHours(slotStart)) continue;
                
                const slotEnd = new Date(slotStart.getTime() + SLOT_DURATION_MINUTES * 60000);
                
                // Verifica se lo slot è libero
                const isSlotFree = !events.some(event => {
                    const eventStart = new Date(event.start.dateTime || event.start.date);
                    const eventEnd = new Date(event.end.dateTime || event.end.date);
                    return (slotStart < eventEnd && slotEnd > eventStart);
                });
                
                if (isSlotFree) {
                    availableSlots.push({
                        start: new Date(slotStart),
                        end: new Date(slotEnd),
                        date: slotStart.toLocaleDateString('it-IT'),
                        time: slotStart.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
                    });
                }
            }
            
            // Passa al giorno successivo
            currentDate.setDate(currentDate.getDate() + 1);
        }
        
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
    
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() + (weekOffset * 7));
    startOfWeek.setHours(0, 0, 0, 0);
    
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);
    
    const slots = await getAvailableSlots(startOfWeek, endOfWeek);
    
    return {
        week: `${startOfWeek.toLocaleDateString('it-IT')} - ${endOfWeek.toLocaleDateString('it-IT')}`,
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
        
        const event = {
            summary: `Intervento - ${customerName}`,
            description: `Cliente: ${customerName}\nTelefono: ${customerPhone}\nIndirizzo: ${address}`,
            start: {
                dateTime: startDateTime.toISOString(),
                timeZone: 'Europe/Rome',
            },
            end: {
                dateTime: endDateTime.toISOString(),
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
    
    // ← NUOVO: Controlla se la data richiesta cade nel weekend
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
        
        let filteredSlots = slots;
        if (period === 'morning') filteredSlots = slots.filter(s => s.start.getHours() < WORKING_HOURS.lunchStart);
        else if (period === 'afternoon') filteredSlots = slots.filter(s => s.start.getHours() >= WORKING_HOURS.lunchEnd);
        
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
