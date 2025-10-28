// services/hubspot.js
import config from '../config/index.js';

export const getSignedFileUrl = async (fileId) => {
    const response = await fetch(`${config.HUBSPOT_CONFIG.urls.file}/${fileId}/signed-url`, {
        headers: { Authorization: `Bearer ${config.HUBSPOT_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    if (!response.ok || !data.url) throw new Error('Failed to get signed URL');
    return data.url;
};

export const updateProperty = async (objectType, objectId, propertyName, propertyValue) => {
    const url = `${config.HUBSPOT_CONFIG.urls.object}/${objectType}/${objectId}`;
    const body = {
        properties: {
            [propertyName]: typeof propertyValue === 'object' ? JSON.stringify(propertyValue) : propertyValue
        }
    };

    const response = await fetch(url, {
        method: "PATCH",
        headers: {
            "Authorization": `Bearer ${config.HUBSPOT_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`HubSpot update failed: ${response.status}`);
    return response.json();
};

export const getHubSpotRecord = async (objectType, objectId, properties = '') => {
    const url = `${config.HUBSPOT_CONFIG.urls.object}/${objectType}/${objectId}?properties=${properties}`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${config.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });
    if (!response.ok) throw new Error(`HubSpot API error: ${response.status}`);
    return response.json();
};

export const fetchHubSpotAssociatedData = async (objectType, objectId, toObjectType, limit = 100) => {
    const url = `${config.HUBSPOT_CONFIG.urls.association}/${objectType}/${objectId}/associations/${toObjectType}?limit=${limit}`;
    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${config.HUBSPOT_ACCESS_TOKEN}` }
    });
    
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
};

export const fetchHubSpotBatchRecords = async (objectTypeId, ids, properties, archived = false) => {
    const url = `${config.HUBSPOT_CONFIG.urls.object}/${objectTypeId}/batch/read`;
    const body = {
        inputs: ids.map(id => ({ id: id.toString() })),
        properties,
        archived
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
};

export const updateErrorLog = async (objectTypeId, recordId, errorMessage, additionalData = {}) => {
    const errorData = {
        error: true,
        errorMessage: errorMessage,
        timestamp: new Date().toISOString(),
        ...additionalData
    };

    await updateProperty(objectTypeId, recordId, config.HUBSPOT_CONFIG.properties.errorLog, errorData);
    console.log('Error log updated successfully in HubSpot');
};

export const updateIndividualProperties = async (objectTypeId, recordId, extractedData) => {
    const fullName = [extractedData?.firstName, extractedData?.lastName].filter(Boolean).join(' ');
    const propertiesToUpdate = {
        'extracted_full_name': fullName,
        'extracted_address': extractedData?.streetAddress,
        'extracted_dob': extractedData?.dateOfBirth,
        'extracted_nationality': extractedData?.nationality,
        'extracted_work_permit_date': extractedData?.workPermitDate,
        'extracted_work_permit_type': extractedData?.workPermitType
    };

    const updates = [];
    for (const [propertyName, propertyValue] of Object.entries(propertiesToUpdate)) {
        if (!propertyValue) continue;
        try {
            await updateProperty(objectTypeId, recordId, propertyName, propertyValue);
            updates.push({ property: propertyName, success: true });
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            updates.push({ property: propertyName, success: false, error: error.message });
        }
    }
    return updates;
};

export const getObjectTypeBySubscription = (subscriptionType) => {
    const subscriptionMap = {
        "contact.propertyChange": config.HUBSPOT_CONFIG.objectTypes.contact,
        "company.propertyChange": config.HUBSPOT_CONFIG.objectTypes.company,
        "deal.propertyChange": config.HUBSPOT_CONFIG.objectTypes.deal,
        "ticket.propertyChange": config.HUBSPOT_CONFIG.objectTypes.ticket
    };

    if (subscriptionMap[subscriptionType]) {
        return subscriptionMap[subscriptionType];
    }

    if (subscriptionType.endsWith('.propertyChange')) {
        const objectName = subscriptionType.replace('.propertyChange', '');
        return `p_${objectName}`;
    }

    throw new Error(`Unknown subscription type: ${subscriptionType}`);
};

export default {
    getSignedFileUrl,
    updateProperty,
    getHubSpotRecord,
    fetchHubSpotAssociatedData,
    fetchHubSpotBatchRecords,
    updateErrorLog,
    updateIndividualProperties,
    getObjectTypeBySubscription
};