const { db, collections } = require('../config/firebase-config.cjs');
const admin = require('firebase-admin');

class FirestoreService {
  // ============================================
  // CUSTOMER METHODS
  // ============================================

  async createCustomer(customerId, customerData) {
    try {
      await collections.customers.doc(customerId).set({
        ...customerData,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { success: true, customerId };
    } catch (error) {
      console.error('Error creating customer:', error);
      throw error;
    }
  }

  async getCustomer(customerId) {
    try {
      const doc = await collections.customers.doc(customerId).get();
      if (!doc.exists) {
        return null;
      }
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('Error getting customer:', error);
      throw error;
    }
  }

  async updateCustomer(customerId, updates) {
    try {
      await collections.customers.doc(customerId).update({
        ...updates,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { success: true };
    } catch (error) {
      console.error('Error updating customer:', error);
      throw error;
    }
  }

  // ============================================
  // PROPERTY METHODS
  // ============================================

  async createProperty(propertyId, propertyData) {
    try {
      await collections.properties.doc(propertyId).set({
        ...propertyData,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { success: true, propertyId };
    } catch (error) {
      console.error('Error creating property:', error);
      throw error;
    }
  }

  async getProperty(propertyId) {
    try {
      const doc = await collections.properties.doc(propertyId).get();
      if (!doc.exists) {
        return null;
      }
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('Error getting property:', error);
      throw error;
    }
  }

  async getPropertiesByCustomer(customerId) {
    try {
      const snapshot = await collections.properties
        .where('ownerId', '==', customerId)
        .get();
      
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    } catch (error) {
      console.error('Error getting properties by customer:', error);
      throw error;
    }
  }

  // ============================================
  // SENSOR METHODS
  // ============================================

  async registerSensor(sensorId, sensorData) {
    try {
      await collections.sensors.doc(sensorId).set({
        ...sensorData,
        status: 'active',
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
        registeredAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return { success: true, sensorId };
    } catch (error) {
      console.error('Error registering sensor:', error);
      throw error;
    }
  }

  async getSensor(sensorId) {
    try {
      const doc = await collections.sensors.doc(sensorId).get();
      if (!doc.exists) {
        return null;
      }
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('Error getting sensor:', error);
      throw error;
    }
  }

  async getSensorsByProperty(propertyId) {
    try {
      const snapshot = await collections.sensors
        .where('propertyId', '==', propertyId)
        .get();
      
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    } catch (error) {
      console.error('Error getting sensors by property:', error);
      throw error;
    }
  }

  async getAllSensors() {
    try {
      const snapshot = await collections.sensors.get();
      
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    } catch (error) {
      console.error('Error getting all sensors:', error);
      throw error;
    }
  }

  async updateSensorStatus(sensorId, status, additionalData = {}) {
    try {
      await collections.sensors.doc(sensorId).set({
        status,
        ...additionalData,
        lastSeen: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return { success: true };
    } catch (error) {
      console.error('Error updating sensor status:', error);
      throw error;
    }
  }

  async updateDevice(deviceId, updateData) {
    try {
      await collections.sensors.doc(deviceId).set({
        ...updateData,
        lastSeen: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return { success: true };
    } catch (error) {
      console.error('Error updating device:', error);
      throw error;
    }
  }

  // ============================================
  // SENSOR READINGS METHODS
  // ============================================

  async saveSensorReading(sensorId, readingData) {
    try {
      const readingRef = await collections.sensor_readings.add({
        sensorId,
        deviceId: readingData.deviceId || sensorId, // Ensure deviceId is always present for frontend queries
        ...readingData,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      // Update sensor's last seen time
      await this.updateSensorStatus(sensorId, 'active', {
        lastReading: readingData
      });

      return { success: true, readingId: readingRef.id };
    } catch (error) {
      console.error('Error saving sensor reading:', error);
      throw error;
    }
  }

  async getLatestReading(sensorId) {
    try {
      const snapshot = await collections.sensor_readings
        .where('sensorId', '==', sensorId)
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();
      
      if (snapshot.empty) {
        return null;
      }

      const doc = snapshot.docs[0];
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('Error getting latest reading:', error);
      throw error;
    }
  }

  async getReadingHistory(sensorId, limit = 100) {
    try {
      const snapshot = await collections.sensor_readings
        .where('sensorId', '==', sensorId)
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .get();
      
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    } catch (error) {
      console.error('Error getting reading history:', error);
      throw error;
    }
  }

  // ============================================
  // ALERT METHODS
  // ============================================

  async createAlert(alertData) {
    try {
      const alertRef = await collections.alerts.add({
        ...alertData,
        resolved: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { success: true, alertId: alertRef.id };
    } catch (error) {
      console.error('Error creating alert:', error);
      throw error;
    }
  }

  async getActiveAlerts(propertyId = null) {
    try {
      let query = collections.alerts.where('resolved', '==', false);
      
      if (propertyId) {
        query = query.where('propertyId', '==', propertyId);
      }

      const snapshot = await query
        .orderBy('createdAt', 'desc')
        .get();
      
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    } catch (error) {
      console.error('Error getting active alerts:', error);
      throw error;
    }
  }

  async resolveAlert(alertId, resolvedBy, notes = '') {
    try {
      await collections.alerts.doc(alertId).update({
        resolved: true,
        resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
        resolvedBy,
        resolutionNotes: notes
      });
      return { success: true };
    } catch (error) {
      console.error('Error resolving alert:', error);
      throw error;
    }
  }

  // ============================================
  // REAL-TIME LISTENERS
  // ============================================

  listenToSensorReadings(sensorId, callback) {
    return collections.sensor_readings
      .where('sensorId', '==', sensorId)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'added') {
            callback({ id: change.doc.id, ...change.doc.data() });
          }
        });
      });
  }

  listenToPropertyAlerts(propertyId, callback) {
    return collections.alerts
      .where('propertyId', '==', propertyId)
      .where('resolved', '==', false)
      .onSnapshot(snapshot => {
        const alerts = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
        callback(alerts);
      });
  }
}

module.exports = new FirestoreService();
